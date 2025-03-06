require('dotenv').config();
const { Telegraf } = require('telegraf');
const sessionMiddleware = require('./middlewares/sessionMiddleware');
const commonHandlers = require('./handlers/commonHandlers');
const adminHandlers = require('./handlers/adminHandlers');
const workerHandlers = require('./handlers/workerHandlers');
const logger = require('./utils/logger');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Middleware
bot.use(sessionMiddleware);

// Handlers
commonHandlers(bot);
adminHandlers(bot);
workerHandlers(bot);

// Error handling
bot.catch((err, ctx) => {
    logger.error(`Error for ${ctx.updateType}: ${err.message}`);
    ctx.reply('An error occurred. Please try again.');
});

// Start the bot
bot.launch();
logger.info('Bot started successfully.');