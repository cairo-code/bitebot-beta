const { mainMenu } = require('../utils/keyboard');
const logger = require('../utils/logger');

module.exports = (bot) => {
    bot.start((ctx) => {
        logger.info(`User ${ctx.from.id} started the bot.`);
        ctx.reply('Welcome! Choose an option:', mainMenu);
    });

    bot.action('register_admin', (ctx) => {
        ctx.reply('Please send: /register admin <company_name>');
    });

    bot.action('register_worker', (ctx) => {
        ctx.reply('Please send: /register worker <company_name>');
    });
};