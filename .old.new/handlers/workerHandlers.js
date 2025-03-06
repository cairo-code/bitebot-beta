const { workerMenu } = require('../utils/keyboard');
const pool = require('../config/db');
const logger = require('../utils/logger');

module.exports = (bot) => {
    bot.command('createorder', async (ctx) => {
        const userId = ctx.from.id;
        const text = ctx.message.text.split(' ');
        if (text.length < 2) {
            return ctx.reply('Usage: /createorder <restaurant_id>');
        }
        const restaurantId = text[1];

        try {
            const connection = await pool.getConnection();
            const [rows] = await connection.query('SELECT role FROM users WHERE user_id = ?', [userId]);
            if (rows.length === 0 || rows[0].role !== 'worker') {
                return ctx.reply('Only workers can create orders.');
            }
            await connection.query('INSERT INTO orders (worker_id, restaurant_id, status) VALUES (?, ?, ?)', [userId, restaurantId, 'pending']);
            connection.release();
            ctx.reply('Order created successfully.', workerMenu);
        } catch (error) {
            logger.error(`Error creating order: ${error.message}`);
            ctx.reply('Failed to create order. Please try again.');
        }
    });

    // Add more worker commands here...
};