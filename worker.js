const mysql = require('mysql2/promise');

class WorkerActions {
  constructor(pool) {
    this.pool = pool;
  }

  async handleWorkerActions(msg, user) {
    const text = msg.text;
    const chatId = msg.chat.id;

    switch(text) {
      case 'Join Existing Orders':
        await this.initiateJoinGroupOrder(chatId);
        break;
      case 'View My Group Orders':
        await this.initiateViewWorkerGroupOrders(chatId);
        break;
      case 'Logout':
        await this.logout(chatId);
        break;
    }
  }

  async initiateJoinGroupOrder(chatId) {
    try {
      const [groupOrders] = await this.pool.execute(`
        SELECT o.order_group_id, r.name AS restaurant_name, o.status
        FROM orders o
        JOIN restaurants r ON o.restaurant_id = r.id
        WHERE o.is_admin_created = TRUE AND o.status = 'open'
      `);

      if (groupOrders.length === 0) {
        await this.bot.sendMessage(chatId, 'No open group orders available.');
        return;
      }

      const keyboard = {
        inline_keyboard: groupOrders.map(order => [
          {
            text: `Join ${order.restaurant_name} Group Order (${order.order_group_id})`,
            callback_data: `join_group_order_${order.order_group_id}`
          }
        ])
      };

      await this.bot.sendMessage(chatId, 'Select a group order to join:', {
        reply_markup: keyboard
      });
    } catch (error) {
      logger.error('Error fetching group orders for worker:', error);
      await this.bot.sendMessage(chatId, 'Failed to retrieve group orders.');
    }
  }

  async initiateViewWorkerGroupOrders(chatId) {
    try {
      const [groupOrders] = await this.pool.execute(`
        SELECT DISTINCT o.order_group_id, r.name AS restaurant_name
        FROM orders o
        JOIN order_items oi ON o.id = oi.order_id
        JOIN restaurants r ON o.restaurant_id = r.id
        WHERE oi.worker_id = ? AND o.is_admin_created = TRUE
      `, [chatId]);

      if (groupOrders.length === 0) {
        await this.bot.sendMessage(chatId, 'No group orders found.');
        return;
      }

      const keyboard = {
        inline_keyboard: groupOrders.map(order => [
          {
            text: `View ${order.restaurant_name} Group Order (${order.order_group_id})`,
            callback_data: `view_worker_group_order_${order.order_group_id}`
          }
        ])
      };

      await this.bot.sendMessage(chatId, 'Select a group order to view:', {
        reply_markup: keyboard
      });
    } catch (error) {
      logger.error('Error fetching worker group orders:', error);
      await this.bot.sendMessage(chatId, 'Failed to retrieve group orders.');
    }
  }

  async logout(chatId) {
    await this.bot.sendMessage(chatId, 'Logged out successfully.');
    await this.handleStart({ chat: { id: chatId } });
  }
}

module.exports = WorkerActions;