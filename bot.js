const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");

const TOKEN = "8919955322:AAECN77ybpt9B1JXDeYd5z-6ZPBZqmn63fg";
const GROUP_ID = "-1003836861323";

const DATA_FILE = "players.json";
const CHECK_INTERVAL = 120000; // 120 giây

const bot = new TelegramBot(TOKEN, { polling: true });

// Hệ thống tính điểm để sắp xếp Bảng Xếp Hạng (Rank Weight)
const RANK_ORDER = [
  "CHALLENGER",
  "GRANDMASTER",
  "MASTER",
  "DIAMOND",
  "EMERALD",
  "PLATINUM",
  "GOLD",
  "SILVER",
  "BRONZE",
  "IRON",
];
const DIV_ORDER = ["I", "II", "III", "IV"];

// Bảng cấu hình dịch Rank sang Tiếng Việt
const RANK_TRANSLATION = {
  CHALLENGER: "Thách Đấu",
  GRANDMASTER: "Đại Cao Thủ",
  MASTER: "Cao Thủ",
  DIAMOND: "Kim Cương",
  EMERALD: "Lục Bảo",
  PLATINUM: "Bạch Kim",
  GOLD: "Vàng",
  SILVER: "Bạc",
  BRONZE: "Đồng",
  IRON: "Sắt",
};

// Hàm hỗ trợ format Rank sang Tiếng Việt (Ví dụ: "SILVER III" -> "Bạc III")
function translateRank(rankStr) {
  if (!rankStr || rankStr.includes("Chưa") || rankStr.includes("CHƯA"))
    return rankStr;

  const parts = rankStr.toUpperCase().split(" ");
  const tier = parts[0];
  const div = parts[1] || "";

  const translatedTier = RANK_TRANSLATION[tier] || tier;
  return div ? `${translatedTier} ${div}` : translatedTier;
}

// ======================
// LOAD / SAVE DATA
// ======================
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { players: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let data = loadData();

// ======================
// API & HELPERS
// ======================
async function getPlayerData(name, tag) {
  const encodedName = encodeURIComponent(name);
  const encodedTag = encodeURIComponent(tag);
  const url = `https://ap.tft.tools/player/stats2/vn2/${encodedName}/${encodedTag}/170/50`;

  try {
    const res = await axios.get(url, { timeout: 15000 });
    return res.data;
  } catch (e) {
    console.error(
      `[LỖI API] Không lấy được data của ${name}#${tag}: ${e.message}`,
    );
    return null;
  }
}

function getLastMatchInfo(apiData) {
  try {
    const match = apiData.matches[0];
    return {
      id: match.id,
      placement: match.info.placement,
      rankAfter: match.rankAfter, // ["SILVER III", 90]
      lpDiff: match.lpDiff,
      units: match.info.units,
    };
  } catch {
    return null;
  }
}

// Hàm làm sạch tên Tướng và hiển thị kèm trang bị
function formatUnits(units) {
  if (!units || !Array.isArray(units)) return "Không rõ";
  return units
    .filter((u) => !u.id.includes("Summon") && !u.id.includes("Minion"))
    .sort((a, b) => b.tier - a.tier) // Ưu tiên tướng nhiều sao lên trước
    .map((u) => {
      const cleanName = u.id.replace(/^TFT\d+_\s*/, "");
      const stars = "⭐".repeat(u.tier);

      // Xử lý trang bị của tướng (nếu có)
      let itemsStr = "";
      if (u.items && u.items.length > 0) {
        const cleanItems = u.items
          .map((item) =>
            String(item)
              .replace(/^TFT_Item_/, "")
              .replace(/^TFT\d+_Item_/, ""),
          )
          .join(", ");
        itemsStr = ` <i>[${cleanItems}]</i>`;
      }

      return `• <b>${cleanName}</b> ${stars}${itemsStr}`;
    })
    .join("\n");
}

// Hàm tính điểm Rank để sort BXH
function getRankScore(rankStr, lp) {
  if (!rankStr) return 0;
  const parts = rankStr.toUpperCase().split(" ");
  const tier = parts[0];
  const div = parts[1] || "";

  const tierIndex = RANK_ORDER.indexOf(tier);
  const tierScore =
    tierIndex !== -1 ? (RANK_ORDER.length - tierIndex) * 100000 : 0;

  const divIndex = DIV_ORDER.indexOf(div);
  const divScore = divIndex !== -1 ? (DIV_ORDER.length - divIndex) * 10000 : 0;

  return tierScore + divScore + (lp || 0);
}

// ======================
// BOT COMMANDS
// ======================

// /add Tên#Tag
bot.onText(/\/add (.+)/, (msg, match) => {
  const input = match[1];
  const parts = input.split("#");

  if (parts.length !== 2) {
    bot.sendMessage(
      msg.chat.id,
      "⚠️ Sai định dạng! Vui lòng nhập theo dạng: <code>/add Tên Người Chơi#Tag</code>",
      { parse_mode: "HTML" },
    );
    return;
  }

  const name = parts[0].trim();
  const tag = parts[1].trim();

  const exists = data.players.find(
    (p) =>
      p.name.toLowerCase() === name.toLowerCase() &&
      p.tag.toLowerCase() === tag.toLowerCase(),
  );
  if (exists) {
    bot.sendMessage(
      msg.chat.id,
      "❌ Người chơi này đã có trong danh sách theo dõi.",
    );
    return;
  }

  data.players.push({
    name,
    tag,
    last_match_id: "",
    rankTier: "Chưa cập nhật",
    rankLP: 0,
  });

  saveData(data);
  bot.sendMessage(msg.chat.id, `✅ Đã thêm thành công: <b>${name}#${tag}</b>`, {
    parse_mode: "HTML",
  });
});

// /remove Tên#Tag
bot.onText(/\/remove (.+)/, (msg, match) => {
  const input = match[1];
  const parts = input.split("#");

  if (parts.length !== 2) {
    bot.sendMessage(
      msg.chat.id,
      "⚠️ Sai định dạng! Vui lòng nhập: <code>/remove Tên#Tag</code>",
      { parse_mode: "HTML" },
    );
    return;
  }

  const name = parts[0].trim();
  const tag = parts[1].trim();

  const originalLength = data.players.length;
  data.players = data.players.filter(
    (p) =>
      !(
        p.name.toLowerCase() === name.toLowerCase() &&
        p.tag.toLowerCase() === tag.toLowerCase()
      ),
  );

  if (data.players.length === originalLength) {
    bot.sendMessage(
      msg.chat.id,
      "❌ Không tìm thấy người chơi này trong danh sách.",
    );
  } else {
    saveData(data);
    bot.sendMessage(
      msg.chat.id,
      `🗑️ Đã xoá người chơi <b>${name}#${tag}</b> khỏi danh sách.`,
      { parse_mode: "HTML" },
    );
  }
});

// /list
bot.onText(/\/list/, (msg) => {
  if (data.players.length === 0) {
    bot.sendMessage(msg.chat.id, "📋 Danh sách theo dõi đang trống.");
    return;
  }

  let text = "📋 <b>Danh sách cờ thủ đang theo dõi:</b>\n";
  data.players.forEach((p) => {
    // Đã bọc hàm translateRank ở đây
    text += `• ${p.name}#${p.tag} <i>(${translateRank(p.rankTier) || "Chưa rõ"} - ${p.rankLP || 0} LP)</i>\n`;
  });

  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// /bxh - Xem ai trình cao nhất nhóm
bot.onText(/\/bxh/, (msg) => {
  if (data.players.length === 0) {
    bot.sendMessage(msg.chat.id, "📋 Danh sách trống, không thể lập BXH.");
    return;
  }

  // Sắp xếp người chơi dựa trên điểm Rank tiếng Anh gốc
  const sortedPlayers = [...data.players].sort((a, b) => {
    return (
      getRankScore(b.rankTier, b.rankLP) - getRankScore(a.rankTier, a.rankLP)
    );
  });

  let text = "🏆 <b>BẢNG XẾP HẠNG</b> 🏆\n\n";
  sortedPlayers.forEach((p, index) => {
    let medal = "🔹";
    if (index === 0) medal = "🥇 👑";
    else if (index === 1) medal = "🥈";
    else if (index === 2) medal = "🥉";
    else if (index === sortedPlayers.length - 1) medal = "🤡";

    // Đã bọc hàm translateRank ở đây để hiển thị Tiếng Việt
    text += `${medal} <b>Top ${index + 1}:</b> ${p.name}#${p.tag}\n   ↳ 🎖️ Rank: <code>${translateRank(p.rankTier) || "CHƯA ĐÁNH"}</code> (${p.rankLP || 0} LP)\n\n`;
  });

  bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// ======================
// LOOP CYCLE CHECK
// ======================
async function checkLoop() {
  console.log(
    `[${new Date().toLocaleTimeString()}] Đang kiểm tra trận đấu mới...`,
  );

  for (const player of data.players) {
    const apiData = await getPlayerData(player.name, player.tag);
    if (!apiData) continue;

    const match = getLastMatchInfo(apiData);
    if (!match) continue;

    // Lấy thông tin xếp hạng mới nhất (Vẫn là gốc Tiếng Anh để lưu DB không lỗi logic sort)
    const rankTier = match?.rankAfter?.[0] || "Chưa cập nhật";
    const rankLP = match?.rankAfter?.[1] || 0;

    // Cập nhật Rank liên tục vào DB để phục vụ lệnh /bxh
    player.rankTier = rankTier;
    player.rankLP = rankLP;
    saveData(data);

    // Nếu phát hiện Match ID mới => Người chơi vừa kết thúc trận đấu
    if (match.id !== player.last_match_id) {
      player.last_match_id = match.id;
      saveData(data);

      const lpChangeStr =
        match.lpDiff > 0 ? `+${match.lpDiff}` : `${match.lpDiff}`;
      const unitsStr = formatUnits(match.units);

      // Xây dựng template tin nhắn HTML siêu đẹp (Đã bọc translateRank(rankTier))
      const notificationMsg =
        `👑 <b>${player.name}#${player.tag}</b> vừa kết thúc trận đấu!\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🎯 <b>Kết quả: </b><b>Top ${match.placement}</b>\n` + // Sửa lại tag đóng b lỗi ở code cũ <b> thành </b>
        `🏅 <b>Xếp hạng hiện tại:</b> <code>${translateRank(rankTier)}</code> (${rankLP} LP)\n` +
        `📈 <b>Biến động:</b> <b>${lpChangeStr} LP</b>\n` +
        `🧩 <b>Đội hình cuối trận:</b>\n${unitsStr}`;

      bot.sendMessage(GROUP_ID, notificationMsg, { parse_mode: "HTML" });
    }
  }
}

// Khởi chạy vòng lặp ngầm
setInterval(checkLoop, CHECK_INTERVAL);
checkLoop();

console.log("Bot TFT bảnh tỏn đã được kích hoạt thành công!");
