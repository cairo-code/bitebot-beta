const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');

dotenv.config();

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' })
  ]
});

class RestaurantOrderBot {
  constructor() {
    this.bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
    this.pool = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
    this.userStates = {};
    this.initializeListeners();
  }

  initializeListeners() {
    this.bot.onText(/\/start/, (msg) => this.handleStart(msg));

    this.bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const text = msg.text;
      const userState = this.getUserState(chatId);

      if (userState.expecting === 'name') {
        await this.processNameRegistration(msg);
      } else if (userState.expecting === 'phone_number') {
        await this.processPhoneNumberRegistration(msg);
      } else if (userState.expecting === 'restaurant_name') {
        await this.processAddRestaurant(msg);
      } else if (userState.expecting === 'menu_item') {
        await this.processAddMenuItem(msg);
      } else if (userState.expecting === 'worker_group_order') {
        await this.processWorkerGroupOrder(msg);
      }
    });

    this.bot.on('callback_query', async (callbackQuery) => {
      const message = callbackQuery.message;
      const data = callbackQuery.data;
      const chatId = message.chat.id;

      try {
        if (data === 'register_admin') {
          await this.startRegistration(message, 'admin');
        } else if (data === 'register_worker') {
          await this.startRegistration(message, 'worker');
        } else if (data.startsWith('restaurant_')) {
          const restaurantId = data.split('_')[1];
          await this.selectRestaurantForGroupOrder(chatId, restaurantId);
        } else if (data.startsWith('add_menu_item_')) {
          const restaurantId = data.split('_')[3];
          await this.startAddMenuItem(chatId, restaurantId);
        } else if (data.startsWith('group_order_')) {
          const restaurantId = data.split('_')[2];
          await this.createGroupOrder(chatId, restaurantId);
        } else if (data.startsWith('join_group_order_')) {
          const orderGroupId = data.split('_')[3];
          await this.joinGroupOrder(chatId, orderGroupId);
        } else if (data.startsWith('view_group_order_')) {
          const orderGroupId = data.split('_')[3];
          await this.showGroupOrderDetails(chatId, orderGroupId);
        } else if (data.startsWith('toggle_paid_')) {
          const parts = data.split('_');
          const orderGroupId = parts[2];
          const workerId = parts[3];
          await this.toggleWorkerPaidStatus(chatId, orderGroupId, workerId);
        } else if (data.startsWith('update_group_order_status_')) {
          const parts = data.split('_');
          const orderGroupId = parts[3];
          const newStatus = parts[4];
          await this.updateGroupOrderStatus(chatId, orderGroupId, newStatus);
        } else if (data === 'back_to_group_orders') {
          await this.viewGroupOrders(chatId);
        } else if (data.startsWith('view_worker_group_order_')) {
          const orderGroupId = data.split('_')[4];
          await this.showGroupOrderDetails(chatId, orderGroupId);
        }
      } catch (error) {
        logger.error('Callback query error:', error);
      }
    });

    this.bot.on('text', async (msg) => {
      const chatId = msg.chat.id;
      const text = msg.text;
      const user = await this.getUserByTelegramId(chatId);

      if (!user) return;

      if (user.role === 'admin') {
        await this.handleAdminActions(msg, user);
      } else if (user.role === 'worker') {
        await this.handleWorkerActions(msg, user);
      }
    });
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
        message += `\n`;
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

  async viewGroupOrders(chatId) {
    try {
      const [groupOrders] = await this.pool.execute(`
        SELECT o.order_group_id, r.name AS restaurant_name, o.status
        FROM orders o
        JOIN restaurants r ON o.restaurant_id = r.id
        WHERE r.admin_id = ? AND o.is_admin_created = TRUE
      `, [chatId]);

      if (groupOrders.length === 0) {
        await this.bot.sendMessage(chatId, 'No group orders found.');
        return;
      }

      const keyboard = {
        inline_keyboard: groupOrders.map(order => [
          { 
            text: `${order.restaurant_name} - ${order.order_group_id} (${order.status})`, 
            callback_data: `view_group_order_${order.order_group_id}` 
          }
        ])
      };

      await this.bot.sendMessage(chatId, 'Select a group order to view:', {
        reply_markup: keyboard
      });
    } catch (error) {
      logger.error('View group orders error:', error);
      await this.bot.sendMessage(chatId, 'Error fetching group orders.');
    }
  }

  async initializeDatabase() {
    const connection = await this.pool.getConnection();

    try {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY, 
          user_id BIGINT UNIQUE NOT NULL,
          role ENUM('admin', 'worker') NOT NULL DEFAULT 'worker',
          name VARCHAR(255) NOT NULL,
          phone_number VARCHAR(20) NOT NULL,
          uuid VARCHAR(36) UNIQUE NOT NULL
        )
      `);

      await connection.query(`
        CREATE TABLE IF NOT EXISTS restaurants (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          admin_id BIGINT,
          FOREIGN KEY (admin_id) REFERENCES users(user_id)
        )
      `);

      await connection.query(`
        CREATE TABLE IF NOT EXISTS menu_items (
          id INT AUTO_INCREMENT PRIMARY KEY,
          restaurant_id INT,
          item_name VARCHAR(255) NOT NULL,
          item_price DECIMAL(10,2) NOT NULL,
          FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
        )
      `);

      await connection.query(`
        CREATE TABLE IF NOT EXISTS orders (
          id INT AUTO_INCREMENT PRIMARY KEY,
          worker_id BIGINT, 
          restaurant_id INT,
          status ENUM('pending', 'approved', 'rejected', 'completed', 'open', 'outForDelivery', 'arrived') DEFAULT 'open',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          is_admin_created BOOLEAN DEFAULT FALSE,
          order_group_id VARCHAR(255),
          FOREIGN KEY (worker_id) REFERENCES users(user_id),
          FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
        )
      `);

      await connection.query(`
        CREATE TABLE IF NOT EXISTS order_items (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_id INT,
          menu_item_id INT,
          quantity INT NOT NULL DEFAULT 1,
          worker_id BIGINT, 
          is_paid BOOLEAN DEFAULT FALSE,
          paid_at TIMESTAMP NULL,
          order_group_id VARCHAR(255),
          FOREIGN KEY (order_id) REFERENCES orders(id),
          FOREIGN KEY (menu_item_id) REFERENCES menu_items(id),
          FOREIGN KEY (worker_id) REFERENCES users(user_id)  
        )
      `);

      logger.info('Database tables initialized successfully');
    } catch (error) {
      logger.error('Database initialization error:', error);
      throw error;
    } finally {
      connection.release();
    }
  }

  async startRegistration(message, role) {
    const chatId = message.chat.id;
    this.setUserState(chatId, { expecting: 'name', role: role });
    await this.bot.sendMessage(chatId, `You are registering as a ${role}. Please enter your full name.`);
  }

  async processNameRegistration(msg) {
    const chatId = msg.chat.id;
    const name = msg.text;
    const userState = this.getUserState(chatId);

    if (!name.trim()) {
      await this.bot.sendMessage(chatId, 'Name cannot be empty. Please enter your full name.');
      return;
    }

    this.setUserState(chatId, { 
      ...userState,
      expecting: 'phone_number',
      name: name 
    });

    await this.bot.sendMessage(chatId, 'Please enter your phone number (e.g., +1234567890).');
  }

  async startAddMenuItem(chatId, restaurantId) {
    this.setUserState(chatId, {
      expecting: 'menu_item',
      selectedRestaurantId: restaurantId
    });
    await this.bot.sendMessage(chatId, 'Enter the menu item name and price separated by a comma (e.g., "Pizza, 10.99"):');
  }

  async viewAdminOrders(chatId) {
    try {
      const [orders] = await this.pool.execute(`
        SELECT o.id, o.status, r.name AS restaurant_name, o.created_at 
        FROM orders o
        JOIN restaurants r ON o.restaurant_id = r.id
        WHERE r.admin_id = ?
      `, [chatId]);
  
      if (orders.length === 0) {
        await this.bot.sendMessage(chatId, 'No orders found.');
        return;
      }
  
      let message = 'Orders:\n\n';
      orders.forEach(order => {
        message += `Order ID: ${order.id}\n`;
        message += `Restaurant: ${order.restaurant_name}\n`;
        message += `Status: ${order.status}\n`;
        message += `Date: ${order.created_at}\n\n`;
      });
  
      await this.bot.sendMessage(chatId, message);
    } catch (error) {
      logger.error('Error viewing admin orders:', error);
      await this.bot.sendMessage(chatId, 'Failed to retrieve orders.');
    }
  }

  async processPhoneNumberRegistration(msg) {
    const chatId = msg.chat.id;
    const phoneNumber = msg.text;
    const userState = this.getUserState(chatId);

    const phoneRegex = /^\+\d{1,15}$/;
    if (!phoneRegex.test(phoneNumber)) {
      await this.bot.sendMessage(chatId, 'Invalid phone number format. Please use international format (e.g., +1234567890).');
      return;
    }

    const uuid = uuidv4();

    try {
      await this.pool.execute(
        'INSERT INTO users (user_id, role, name, phone_number, uuid) VALUES (?, ?, ?, ?, ?)', 
        [chatId, userState.role, userState.name, phoneNumber, uuid]
      );

      this.clearUserState(chatId);
      await this.showRoleMenu(chatId, userState.role);
      await this.bot.sendMessage(chatId, `Successfully registered as ${userState.role}! Your UUID is: ${uuid}`);
    } catch (error) {
      logger.error('Registration error:', error);
      await this.bot.sendMessage(chatId, 'Registration failed. Please try again.');
    }
  }

  async handleStart(msg) {
    const chatId = msg.chat.id;
    const user = await this.getUserByTelegramId(chatId);

    if (user) {
      await this.showRoleMenu(chatId, user.role);
    } else {
      const keyboard = {
        inline_keyboard: [
          [
            { text: 'Register as Admin', callback_data: 'register_admin' },
            { text: 'Register as Worker', callback_data: 'register_worker' }
          ]
        ]
      };

      await this.bot.sendMessage(chatId, 'Welcome! Choose your registration type:', {
        reply_markup: keyboard
      });
    }
  }

  async handleAdminActions(msg, user) {
    const text = msg.text;
    const chatId = msg.chat.id;

    switch(text) {
      case 'Add Restaurant':
        await this.initiateAddRestaurant(chatId);
        break;
      case 'Add Menu Item':
        await this.initiateAddMenuItem(chatId);
        break;
      case 'View Group Orders':
        await this.viewGroupOrders(chatId);
        break;
      case 'View Orders':
        await this.viewAdminOrders(chatId);
        break;
      case 'Create Group Order':
        await this.initiateCreateGroupOrder(chatId);
        break;
      case 'Logout':
        await this.logout(chatId);
        break;
    }
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

  async initiateAddRestaurant(chatId) {
    this.setUserState(chatId, { expecting: 'restaurant_name' });
    await this.bot.sendMessage(chatId, 'Enter the name of the restaurant:');
  }

  async processAddRestaurant(msg) {
    const chatId = msg.chat.id;
    const restaurantName = msg.text;
    const user = await this.getUserByTelegramId(chatId);

    try {
      await this.pool.execute(
        'INSERT INTO restaurants (name, admin_id) VALUES (?, ?)', 
        [restaurantName, chatId]
      );

      this.clearUserState(chatId);
      await this.bot.sendMessage(chatId, `Restaurant "${restaurantName}" added successfully!`);
    } catch (error) {
      logger.error('Add restaurant error:', error);
      await this.bot.sendMessage(chatId, 'Failed to add restaurant. Please try again.');
    }
  }

  async initiateAddMenuItem(chatId) {
    try {
      const [restaurants] = await this.pool.execute(
        'SELECT id, name FROM restaurants WHERE admin_id = ?', 
        [chatId]
      );

      if (restaurants.length === 0) {
        await this.bot.sendMessage(chatId, 'No restaurants found. Please add a restaurant first.');
        return;
      }

      const keyboard = {
        inline_keyboard: restaurants.map(restaurant => [
          { 
            text: restaurant.name, 
            callback_data: `add_menu_item_${restaurant.id}` 
          }
        ])
      };

      await this.bot.sendMessage(chatId, 'Select a restaurant to add a menu item:', {
        reply_markup: keyboard
      });
    } catch (error) {
      logger.error('Fetching restaurants error:', error);
      await this.bot.sendMessage(chatId, 'Error fetching restaurants.');
    }
  }

  async processAddMenuItem(msg) {
    const chatId = msg.chat.id;
    const userState = this.getUserState(chatId);

    try {
      const [itemName, itemPrice] = msg.text.split(',').map(s => s.trim());

      if (!itemName || !itemPrice) {
        throw new Error('Invalid format');
      }

      await this.pool.execute(
        'INSERT INTO menu_items (restaurant_id, item_name, item_price) VALUES (?, ?, ?)', 
        [userState.selectedRestaurantId, itemName, parseFloat(itemPrice)]
      );

      this.clearUserState(chatId);
      await this.bot.sendMessage(chatId, `Menu item "${itemName}" added successfully at $${itemPrice}!`);
    } catch (error) {
      logger.error('Add menu item error:', error);
      await this.bot.sendMessage(chatId, 'Failed to add menu item. Use format: Item Name, Price (e.g., Pasta, 12.50)');
    }
  }

  async initiateCreateGroupOrder(chatId) {
    try {
      const [restaurants] = await this.pool.execute(
        'SELECT id, name FROM restaurants WHERE admin_id = ?',
        [chatId]
      );

      if (restaurants.length === 0) {
        await this.bot.sendMessage(chatId, 'No restaurants available.');
        return;
      }

      const keyboard = {
        inline_keyboard: restaurants.map(restaurant => [
          { 
            text: restaurant.name, 
            callback_data: `group_order_${restaurant.id}` 
          }
        ])
      };

      await this.bot.sendMessage(chatId, 'Select a restaurant for the group order:', {
        reply_markup: keyboard
      });
    } catch (error) {
      logger.error('Create group order error:', error);
      await this.bot.sendMessage(chatId, 'Error creating group order.');
    }
  }

  async selectRestaurantForGroupOrder(chatId, restaurantId) {
    try {
      const [menuItems] = await this.pool.execute(
        'SELECT id, item_name, item_price FROM menu_items WHERE restaurant_id = ?', 
        [restaurantId]
      );

      if (menuItems.length === 0) {
        await this.bot.sendMessage(chatId, 'No menu items available for this restaurant.');
        return;
      }

      this.setUserState(chatId, { 
        expecting: 'worker_group_order', 
        selectedRestaurantId: parseInt(restaurantId),
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
      logger.error('Select restaurant for order error:', error);
      await this.bot.sendMessage(chatId, 'Error preparing order.');
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

  async showRoleMenu(chatId, role) {
    let keyboard = {
      keyboard: [],
      resize_keyboard: true
    };

    if (role === 'admin') {
      keyboard.keyboard = [
        ['Add Restaurant', 'Add Menu Item'],
        ['View Group Orders', 'Create Group Order'],
        ['View Orders'],
        ['Logout']
      ];
    } else if (role === 'worker') {
      keyboard.keyboard = [
        ['Join Existing Orders'],
        ['View My Group Orders'],
        ['Logout']
      ];
    }

    await this.bot.sendMessage(chatId, 'Select an option:', { reply_markup: keyboard });
  }

  async logout(chatId) {
    await this.bot.sendMessage(chatId, 'Logged out successfully.');
    await this.handleStart({ chat: { id: chatId } });
  }

  setUserState(chatId, state) {
    this.userStates[chatId] = state;
  }

  getUserState(chatId) {
    return this.userStates[chatId] || {};
  }

  clearUserState(chatId) {
    delete this.userStates[chatId];
  }

  async getUserByTelegramId(userId) {
    const [rows] = await this.pool.execute(
      'SELECT * FROM users WHERE user_id = ?', 
      [userId]
    );
    return rows[0];
  }

  async start() {
    try {
      await this.initializeDatabase();
      logger.info('Bot started successfully');
      console.log('Bot is running...');
    } catch (error) {
      logger.error('Bot startup error:', error);
    }
  }
}

const bot = new RestaurantOrderBot();
bot.start();

module.exports = RestaurantOrderBot;