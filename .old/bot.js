require('dotenv').config();
const { Telegraf } = require('telegraf');
const { sequelize, User } = require('./models');

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start(async (ctx) => {
  const telegramId = ctx.from.id;
  let user = await User.findOne({ where: { telegram_id: telegramId } });

  if (!user) {
    user = await User.create({
      telegram_id: telegramId,
      name: ctx.from.first_name,
      role: 'worker'
    });
    ctx.reply(`👋 Welcome, ${ctx.from.first_name}! You are now registered.`);
  } else {
    ctx.reply(`Welcome back, ${user.name}!`);
  }
});

bot.launch();
console.log('🤖 BiteBot is running...');

// Handle graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Sync database
sequelize.sync({ alter: true }).then(() => {
  console.log("✅ Database synced!");
}).catch(console.error);
