const { adminMenu } = require('../utils/keyboard');
const pool = require('../config/db');
const logger = require('../utils/logger');

module.exports = (bot) => {
    bot.command('addrestaurant', async (ctx) => {
        const userId = ctx.from.id;
        const text = ctx.message.text.split(' ');
        if (text.length < 2) {
            return ctx.reply('Usage: /addrestaurant <restaurant_name>');
        }
        const restaurantName = text[1];

        try {
            const connection = await pool.getConnection();
            const [rows] = await connection.query('SELECT role FROM users WHERE user_id = ?', [userId]);
            if (rows.length === 0 || rows[0].role !== 'admin') {
                return ctx.reply('Only admins can add restaurants.');
            }
            await connection.query('INSERT INTO restaurants (name, admin_id) VALUES (?, ?)', [restaurantName, userId]);
            connection.release();
            ctx.reply(`Restaurant ${restaurantName} added successfully.`, adminMenu);
        } catch (error) {
            logger.error(`Error adding restaurant: ${error.message}`);
            ctx.reply('Failed to add restaurant. Please try again.');
        }
    });

    // Add more admin commands here...
};