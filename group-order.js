const mysql = require('mysql2/promise');

class GroupOrderManagement {
  constructor(pool) {
    this.pool = pool;
  }

  async createGroupOrder(chatId, restaurantId) {
    try {
      const orderGroupId = `GO-${Date.now()}`;
      const [result] = await this.pool.execute(
        'INSERT INTO orders (restaurant_id, status, is_admin_created, order_group_id) VALUES (?, ?, ?, ?)', 
        [restaurantId, 'open', true, orderGroupId]
      );

      const [workers] = await this.pool.execute(
        'SELECT user_id FROM users WHERE role = "worker"'
      );

      const keyboard = {
        inline_keyboard: [[
          { text: 'Join Group Order', callback_data: `join_group_order_${orderGroupId}` }
        ]]
      };

      for (const worker of workers) {
        await this.bot.sendMessage(worker.user_id, 
          `New Group Order Available!\n` +
          `Order Group ID: ${orderGroupId}\n` +
          `Restaurant: ${await this.getRestaurantName(restaurantId)}`, 
          { reply_markup: keyboard }
        );
      }

      await this.bot.sendMessage(chatId, `Group Order created! Order Group ID: ${orderGroupId}`);
    } catch (error) {
      logger.error('Create group order error:', error);
      await this.bot.sendMessage(chatId, 'Failed to create group order.');
    }
  }

  async getRestaurantName(restaurantId) {
    const [rows] = await this.pool.execute(
      'SELECT name FROM restaurants WHERE id = ?', 
      [restaurantId]
    );
    return rows[0] ? rows[0].name : 'Unknown Restaurant';
  }

  async joinGroupOrder(chatId, orderGroupId) {
    try {
      const [orders] = await this.pool.execute(
        'SELECT id, restaurant_id FROM orders WHERE order_group_id = ? AND status = "open"',
        [orderGroupId]
      );

      if (orders.length === 0) {
        await this.bot.sendMessage(chatId, 'Group order is no longer available.');
        return;
      } 

      const order = orders[0];
      const [menuItems] = await this.pool.execute(
        'SELECT id, item_name, item_price FROM menu_items WHERE restaurant_id = ?', 
        [order.restaurant_id]
      );

      this.setUserState(chatId, { 
        expecting: 'worker_group_order', 
        orderGroupId: orderGroupId,
        orderId: order.id,
        menuItems: menuItems
      });

      let menuMessage = "Group Order Menu:\n";
      menuItems.forEach((item, index) => {
        menuMessage += `${index + 1}. ${item.item_name} - $${item.item_price}\n`;
      });
      menuMessage += "\nEnter your order in the format:\n";
      menuMessage += "ItemNumber1:Quantity1, ItemNumber2:Quantity2\n";
      menuMessage += "Example: 1:2, 3:1 (2 of item 1, 1 of item 3)";

      await this.bot.sendMessage(chatId, menuMessage);
    } catch (error) {
      logger.error('Join group order error:', error);
      await this.bot.sendMessage(chatId, 'Error joining group order.');
    }
  }

  async processWorkerGroupOrder(msg) {
    const chatId = msg.chat.id;
    const userState = this.getUserState(chatId);

    try {
      const orderItems = msg.text.split(',').map(item => {
        const [index, quantity] = item.trim().split(':').map(s => s.trim());
        return { 
          index: parseInt(index) - 1, 
          quantity: parseInt(quantity) 
        };
      });

      if (!orderItems.every(item => 
        !isNaN(item.index) && 
        !isNaN(item.quantity) && 
        item.index >= 0 && 
        item.index < userState.menuItems.length
      )) {
        throw new Error('Invalid order format');
      }

      const worker = await this.getUserByTelegramId(chatId);
      let total = 0;

      for (const item of orderItems) {
        const menuItem = userState.menuItems[item.index];
        const itemTotal = menuItem.item_price * item.quantity;
        total += itemTotal;

        await this.pool.execute(
          'INSERT INTO order_items (order_id, menu_item_id, quantity, worker_id, is_paid, order_group_id) VALUES (?, ?, ?, ?, ?, ?)', 
          [userState.orderId, menuItem.id, item.quantity, chatId, false, userState.orderGroupId]
        );
      }

      const admin = await this.getAdminForGroupOrder(userState.orderGroupId);
      await this.bot.sendMessage(admin.user_id, 
        `New Order for Group Order ${userState.orderGroupId}:\n` +
        `Worker: ${worker.name} (UUID: ${worker.uuid})\n` +
        `Total: $${total.toFixed(2)}`
      );

      this.clearUserState(chatId);
      await this.bot.sendMessage(chatId, 
        `Order added to group order!\n` +
        `Group Order ID: ${userState.orderGroupId}\n` +
        `Total: $${total.toFixed(2)}`
      );
    } catch (error) {
      logger.error('Process worker group order error:', error);
      await this.bot.sendMessage(chatId, 'Failed to add order. Please try again.');
    }
  }

  async getAdminForGroupOrder(orderGroupId) {
    const [rows] = await this.pool.execute(`
      SELECT u.* FROM users u
      JOIN restaurants r ON u.user_id = r.admin_id
      JOIN orders o ON r.id = o.restaurant_id
      WHERE o.order_group_id = ? AND u.role = 'admin'
    `, [orderGroupId]);
    return rows[0];
  }

  async showGroupOrderDetails(chatId, orderGroupId) {
    try {
      const [orders] = await this.pool.execute(
        'SELECT id, status, restaurant_id FROM orders WHERE order_group_id = ? LIMIT 1',
        [orderGroupId]
      );
      const order = orders[0];

      const [orderItems] = await this.pool.execute(`
        SELECT 
          u.name AS worker_name,
          u.uuid AS worker_uuid,
          mi.item_name,
          mi.item_price,
          oi.quantity,
          oi.is_paid,
          oi.id AS order_item_id,
          u.user_id AS worker_id
        FROM order_items oi
        JOIN menu_items mi ON oi.menu_item_id = mi.id
        JOIN users u ON oi.worker_id = u.user_id
        WHERE oi.order_group_id = ?
      `, [orderGroupId]);

      let message = `Group Order Details\nGroup ID: ${orderGroupId}\nStatus: ${order.status}\nRestaurant: ${await this.getRestaurantName(order.restaurant_id)}\n\n`;

      const workerOrders = {};
      orderItems.forEach(item => {
        if (!workerOrders[item.worker_name]) {
          workerOrders[item.worker_name] = [];
        }
        workerOrders[item.worker_name].push(item);
      });

      for (const [workerName, items] of Object.entries(workerOrders)) {
        message += `Worker: ${workerName} (UUID: ${items[0].worker_uuid})\n`;
        items.forEach(item => {
          message += `  • ${item.item_name} x${item.quantity} - $${(item.item_price * item.quantity).toFixed(2)}\n`;
          message += `    Status: ${item.is_paid ? 'Paid' : 'Unpaid'}\n`;
        });
        message += '\n';
      }

      const statusOptions = ['pending', 'approved', 'rejected', 'completed', 'outForDelivery', 'arrived'];
      const statusButtons = statusOptions.map(status => ({
        text: status,
        callback_data: `update_group_order_status_${orderGroupId}_${status}`
      }));

      const toggleButtons = Object.keys(workerOrders).map(workerName => ({
        text: `Toggle Paid Status for ${workerName}`,
        callback_data: `toggle_paid_${orderGroupId}_${workerOrders[workerName][0].worker_id}`
      }));

      const keyboard = {
        inline_keyboard: [
          ...toggleButtons.map(btn => [btn]),
          ...statusButtons.map(btn => [btn]),
          [
            {
              text: 'Back to Group Orders',
              callback_data: 'back_to_group_orders'
            }
          ]
        ]
      };

      await this.bot.sendMessage(chatId, message, { reply_markup: keyboard });
    } catch (error) {
      logger.error('Error showing group order details:', error);
      await this.bot.sendMessage(chatId, 'Failed to retrieve group order details.');
    }
  }

  async toggleWorkerPaidStatus(chatId, orderGroupId, workerId) {
    try {
      const [currentStatus] = await this.pool.execute(
        'SELECT is_paid FROM order_items WHERE order_group_id = ? AND worker_id = ? LIMIT 1',
        [orderGroupId, workerId]
      );
      const newStatus = !currentStatus[0].is_paid;

      await this.pool.execute(
        'UPDATE order_items SET is_paid = ?, paid_at = IF(?, NOW(), NULL) WHERE order_group_id = ? AND worker_id = ?',
        [newStatus, newStatus, orderGroupId, workerId]
      );

      await this.bot.sendMessage(chatId, `Paid status for worker ${workerId} updated to ${newStatus ? 'Paid' : 'Unpaid'}`);
      await this.showGroupOrderDetails(chatId, orderGroupId);
    } catch (error) {
      logger.error('Error toggling paid status:', error);
      await this.bot.sendMessage(chatId, 'Failed to update paid status.');
    }
  }

  async updateGroupOrderStatus(chatId, orderGroupId, newStatus) {
    try {
      await this.pool.execute(
        'UPDATE orders SET status = ? WHERE order_group_id = ?',
        [newStatus, orderGroupId]
      );

      await this.bot.sendMessage(chatId, `Group order status updated to ${newStatus}`);
      await this.showGroupOrderDetails(chatId, orderGroupId);
    } catch (error) {
      logger.error('Error updating group order status:', error);
      await this.bot.sendMessage(chatId, 'Failed to update group order status.');
    }
  }
}

module.exports = GroupOrderManagement;