const { Markup } = require('telegraf');

const mainMenu = Markup.inlineKeyboard([
    [Markup.button.callback('Register as Admin', 'register_admin')],
    [Markup.button.callback('Register as Worker', 'register_worker')]
]);

const adminMenu = Markup.inlineKeyboard([
    [Markup.button.callback('Add Restaurant', 'add_restaurant')],
    [Markup.button.callback('Add Menu Item', 'add_menu_item')],
    [Markup.button.callback('View Orders', 'view_orders')]
]);

const workerMenu = Markup.inlineKeyboard([
    [Markup.button.callback('Create Order', 'create_order')],
    [Markup.button.callback('View My Orders', 'view_my_orders')]
]);

module.exports = { mainMenu, adminMenu, workerMenu };