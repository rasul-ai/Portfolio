const fs = require('fs');

const env = `
const BOT_TOKEN = '${process.env.BOT_TOKEN}';
const CHAT_ID = '${process.env.CHAT_ID}';
`;

fs.writeFileSync('dist/env.js', env);
