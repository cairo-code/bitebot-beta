const TelegramBot = require('node-telegram-bot-api');
const mysql = require('mysql2/promise');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

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
    this.logger = winston.createLogger({
      level: 'info',
      format: winston.format.json(),
      transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' })
      ]
    });
    this.sessions = new Map();
  }

  async initDatabase() {
    try {
      const connection = await this.pool.getConnection();

      await connection.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id BIGINT UNIQUE NOT NULL,
          role ENUM('admin', 'worker') NOT NULL,
          name VARCHAR(255) NOT NULL,
          phone_number VARCHAR(20) NOT NULL,
          uuid VARCHAR(36) NOT NULL,
          restaurant_id INT,
          FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
        )
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS companies (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          admin_id BIGINT NOT NULL,
          FOREIGN KEY (admin_id) REFERENCES users(user_id)
        )
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS restaurants (
          id INT AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          admin_id BIGINT NOT NULL,
          FOREIGN KEY (admin_id) REFERENCES users(user_id)
        )
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS menu_items (
          id INT AUTO_INCREMENT PRIMARY KEY,
          restaurant_id INT NOT NULL,
          item_name VARCHAR(255) NOT NULL,
          item_price DECIMAL(10,2) NOT NULL,
          FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
        )
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS orders (
          id INT AUTO_INCREMENT PRIMARY KEY,
          worker_id BIGINT NOT NULL,
          restaurant_id INT NOT NULL,
          status ENUM('pending', 'approved', 'rejected', 'completed') NOT NULL DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          is_admin_created BOOLEAN NOT NULL,
          order_group_id VARCHAR(36),
          FOREIGN KEY (worker_id) REFERENCES users(user_id),
          FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
        )
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS order_items (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_id INT NOT NULL,
          menu_item_id INT NOT NULL,
          quantity INT NOT NULL,
          worker_id BIGINT NOT NULL,
          is_paid BOOLEAN DEFAULT false,
          paid_at TIMESTAMP NULL,
          order_group_id VARCHAR(36),
          FOREIGN KEY (order_id) REFERENCES orders(id),
          FOREIGN KEY (menu_item_id) REFERENCES menu_items(id),
          FOREIGN KEY (worker_id) REFERENCES users(user_id)
        )
      `);
      connection.release();
      this.logger.info('Database tables initialized successfully.');
    } catch (error) {
      this.logger.error('Error initializing database:', error);
    }
  }

  async start() {
    await this.initDatabase();
    this.setupHandlers();
    this.logger.info('Bot started and database initialized.');
  }

  setupHandlers() {
    this.bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const user = await this.getUserByTelegramId(msg.from.id);
      if (!user) {
        await this.handleRegistration(msg);
      } else {
        if (user.role === 'admin') {
          await this.handleAdminMessage(msg, user);
        } else {
          await this.handleWorkerMessage(msg, user);
        }
      }
    });

    this.bot.on('callback_query', async (query) => {
      const chatId = query.message.chat.id;
      const user = await this.getUserByTelegramId(query.from.id);
      if (!user) {
        if (query.data.startsWith('register_')) {
          const role = query.data.split('_')[1];
          const session = { registrationStep: 'NAME', role };
          this.sessions.set(chatId, session);
          await this.bot.sendMessage(chatId, 'Please enter your full name:');
          await this.bot.answerCallbackQuery(query.id);
        }
        return;
      }

      if (query.data.startsWith('register_worker')) {
        const [companies] = await this.pool.query('SELECT * FROM companies');
        const options = {
          reply_markup: {
            inline_keyboard: companies.map(c => [
              { text: c.name, callback_data: `select_company_${c.id}` }
            ])
          }
        };
        await this.bot.sendMessage(chatId, 'Select your company:', options);
        this.sessions.set(chatId, { registrationStep: 'COMPANY', role: 'worker' });
      }

      if (query.data.startsWith('select_company_')) {
        const companyId = query.data.split('_')[2];
        const session = this.sessions.get(chatId);
        session.companyId = companyId;
        session.registrationStep = 'NAME';
        this.sessions.set(chatId, session);
        await this.bot.sendMessage(chatId, 'Please enter your full name:');
      }

      if (user.role === 'admin') {
        await this.handleAdminCallback(query, user);
      } else {
        await this.handleWorkerCallback(query, user);
      }
    });
  }

  async handleRegistration(msg) {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id;
    let session = this.sessions.get(chatId) || {};

    if (msg.text === '/start' && !session.registrationStep) {
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Admin', callback_data: 'register_admin' }],
            [{ text: 'Worker', callback_data: 'register_worker' }]
          ]
        }
      };
      await this.bot.sendMessage(chatId, 'Welcome! Please choose your role:', options);
      session = { registrationStep: 'ROLE' };
      this.sessions.set(chatId, session);
    } else if (session.registrationStep === 'NAME') {
      const name = msg.text.trim();
      if (!name) {
        await this.bot.sendMessage(chatId, 'Name cannot be empty. Please try again:');
        return;
      }
      session.name = name;
      session.registrationStep = 'PHONE';
      this.sessions.set(chatId, session);
      await this.bot.sendMessage(chatId, 'Please enter your phone number in international format (e.g., +1234567890):');
    } else if (session.registrationStep === 'PHONE') {
      const phoneNumber = msg.text.trim();
      if (!phoneNumber.startsWith('+') || phoneNumber.length < 6) {
        await this.bot.sendMessage(chatId, 'Invalid phone number format. Please try again:');
        return;
      }

      if (session.role === 'admin') {
        session.phoneNumber = phoneNumber;
        session.registrationStep = 'COMPANY';
        this.sessions.set(chatId, session);
        await this.bot.sendMessage(chatId, 'Please enter your company name:');
      } else {
        const uuid = uuidv4();
        try {
          await this.pool.query(
            'INSERT INTO users (user_id, role, name, phone_number, uuid, restaurant_id) VALUES (?, ?, ?, ?, ?, ?)',
            [telegramId, session.role, session.name, phoneNumber, uuid, session.companyId]
          );
          await this.bot.sendMessage(chatId, `Registration successful! Your UUID is: ${uuid}`);
          this.sessions.delete(chatId);
          this.logger.info(`Worker ${telegramId} registered with company ${session.companyId}`);
        } catch (error) {
          this.logger.error('Worker registration error:', error);
          await this.bot.sendMessage(chatId, 'Registration failed. Please try again.');
        }
      }
    } else if (session.registrationStep === 'COMPANY' && session.role === 'admin') {
      const companyName = msg.text.trim();
      if (!companyName) {
        await this.bot.sendMessage(chatId, 'Company name cannot be empty. Please try again:');
        return;
      }

      try {
        const uuid = uuidv4();
        const connection = await this.pool.getConnection();
        await connection.beginTransaction();

        await connection.query(
          'INSERT INTO users (user_id, role, name, phone_number, uuid) VALUES (?, ?, ?, ?, ?)',
          [telegramId, session.role, session.name, session.phoneNumber, uuid]
        );

        const [companyResult] = await connection.query(
          'INSERT INTO companies (name, admin_id) VALUES (?, ?)',
          [companyName, telegramId]
        );

        await connection.query(
          'UPDATE users SET restaurant_id = ? WHERE user_id = ?',
          [companyResult.insertId, telegramId]
        );

        await connection.commit();
        connection.release();

        await this.bot.sendMessage(chatId, `Registration successful! Company "${companyName}" created.\nYour UUID: ${uuid}`);
        this.sessions.delete(chatId);
        this.logger.info(`Admin ${telegramId} registered with company ${companyResult.insertId}`);
      } catch (error) {
        this.logger.error('Admin registration error:', error);
        await this.bot.sendMessage(chatId, 'Registration failed. Please try again.');
      }
    }
  }

  async handleAdminMessage(msg, user) {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (this.sessions.has(chatId)) {
      const session = this.sessions.get(chatId);
      if (session.action === 'ADD_RESTAURANT') {
        const restaurantName = text.trim();
        if (!restaurantName) {
          await this.bot.sendMessage(chatId, 'Restaurant name cannot be empty. Please try again:');
          return;
        }
        try {
          await this.pool.query(
            'INSERT INTO restaurants (name, admin_id) VALUES (?, ?)',
            [restaurantName, user.user_id]
          );
          await this.bot.sendMessage(chatId, `Restaurant "${restaurantName}" added successfully!`);
          this.sessions.delete(chatId);
        } catch (error) {
          this.logger.error('Error adding restaurant:', error);
          await this.bot.sendMessage(chatId, 'Failed to add restaurant. Please try again.');
        }
      } else if (session.action === 'ADD_MENU_ITEM_NAME') {
        const itemName = text.trim();
        if (!itemName) {
          await this.bot.sendMessage(chatId, 'Item name cannot be empty. Please try again:');
          return;
        }
        session.itemName = itemName;
        session.action = 'ADD_MENU_ITEM_PRICE';
        this.sessions.set(chatId, session);
        await this.bot.sendMessage(chatId, 'Please enter the item price:');
      } else if (session.action === 'ADD_MENU_ITEM_PRICE') {
        const price = parseFloat(text);
        if (isNaN(price) || price < 0) {
          await this.bot.sendMessage(chatId, 'Invalid price. Must be a positive number.');
          return;
        }
        try {
          await this.pool.query(
            'INSERT INTO menu_items (restaurant_id, item_name, item_price) VALUES (?, ?, ?)',
            [session.restaurantId, session.itemName, price]
          );
          await this.bot.sendMessage(chatId, 'Menu item added successfully!');
          this.sessions.delete(chatId);
        } catch (error) {
          this.logger.error('Error adding menu item:', error);
          await this.bot.sendMessage(chatId, 'Failed to add menu item. Please try again.');
        }
      }
    } else {
      if (text === '/addrestaurant') {
        this.sessions.set(chatId, { action: 'ADD_RESTAURANT' });
        await this.bot.sendMessage(chatId, 'Please enter the restaurant name:');
      } else if (text === '/addmenuitem') {
        const [restaurants] = await this.pool.query('SELECT * FROM restaurants WHERE admin_id = ?', [user.user_id]);
        const options = {
          reply_markup: {
            inline_keyboard: restaurants.map(r => [
              { text: r.name, callback_data: `addmenuitem_${r.id}` }
            ])
          }
        };
        await this.bot.sendMessage(chatId, 'Select a restaurant to add a menu item:', options);
      } else if (text === '/creategrouporder') {
        const [restaurants] = await this.pool.query('SELECT * FROM restaurants WHERE admin_id = ?', [user.user_id]);
        if (restaurants.length === 0) {
          await this.bot.sendMessage(chatId, 'You have no restaurants. Add a restaurant first.');
          return;
        }
        const options = {
          reply_markup: {
            inline_keyboard: restaurants.map(r => [
              { text: r.name, callback_data: `creategrouporder_${r.id}` }
            ])
          }
        };
        await this.bot.sendMessage(chatId, 'Select a restaurant to create a group order:', options);
      } else if (text === '/viewgrouporders') {
        const [orders] = await this.pool.query('SELECT * FROM orders WHERE is_admin_created = true AND admin_id = ?', [user.user_id]);
        if (orders.length === 0) {
          await this.bot.sendMessage(chatId, 'No group orders found.');
          return;
        }
        const options = {
          reply_markup: {
            inline_keyboard: orders.map(o => [
              { text: `Group ID: ${o.order_group_id}`, callback_data: `viewgroupdetails_${o.order_group_id}` }
            ])
          }
        };
        await this.bot.sendMessage(chatId, 'Select a group order to view details:', options);
      } else if (text === '/updateorderstatus') {
        const [orders] = await this.pool.query('SELECT * FROM orders WHERE is_admin_created = true AND admin_id = ?', [user.user_id]);
        if (orders.length === 0) {
          await this.bot.sendMessage(chatId, 'No group orders found.');
          return;
        }
        const options = {
          reply_markup: {
            inline_keyboard: orders.map(o => [
              { text: `Group ID: ${o.order_group_id}`, callback_data: `updatestatus_${o.order_group_id}` }
            ])
          }
        };
        await this.bot.sendMessage(chatId, 'Select an order to update status:', options);
      } else if (text === '/managepayments') {
        const [groupOrders] = await this.pool.query('SELECT * FROM orders WHERE is_admin_created = true AND admin_id = ?', [user.user_id]);
        if (groupOrders.length === 0) {
          await this.bot.sendMessage(chatId, 'No group orders found.');
          return;
        }
        const options = {
          reply_markup: {
            inline_keyboard: groupOrders.map(o => [
              { text: `Group ID: ${o.order_group_id}`, callback_data: `managepayments_${o.order_group_id}` }
            ])
          }
        };
        await this.bot.sendMessage(chatId, 'Select a group order to manage payments:', options);
      }
    }
  }

  async handleAdminCallback(query, user) {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('addmenuitem_')) {
      const restaurantId = data.split('_')[1];
      this.sessions.set(chatId, { action: 'ADD_MENU_ITEM_NAME', restaurantId });
      await this.bot.sendMessage(chatId, 'Please enter the menu item name:');
      await this.bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('creategrouporder_')) {
      const restaurantId = data.split('_')[1];
      const orderGroupId = uuidv4();
      try {
        await this.pool.query(
          'INSERT INTO orders (worker_id, restaurant_id, is_admin_created, order_group_id) VALUES (?, ?, ?, ?)',
          [user.user_id, restaurantId, true, orderGroupId]
        );
        const [workers] = await this.pool.query('SELECT user_id FROM users WHERE role = "worker"');
        workers.forEach(async worker => {
          try {
            await this.bot.sendMessage(worker.user_id, `New group order created for restaurant ID ${restaurantId}. Join using group ID: ${orderGroupId}`);
          } catch (error) {
            this.logger.error(`Failed to notify worker ${worker.user_id}:`, error);
          }
        });
        await this.bot.sendMessage(chatId, `Group order created with ID: ${orderGroupId}`);
      } catch (error) {
        this.logger.error('Error creating group order:', error);
        await this.bot.sendMessage(chatId, 'Failed to create group order.');
      }
      await this.bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('viewgroupdetails_')) {
      const orderGroupId = data.split('_')[1];
      const [orders] = await this.pool.query('SELECT * FROM orders WHERE order_group_id = ?', [orderGroupId]);
      const [orderItems] = await this.pool.query(`
        SELECT oi.*, u.name AS worker_name, mi.item_name 
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        JOIN users u ON oi.worker_id = u.user_id
        JOIN menu_items mi ON oi.menu_item_id = mi.id
        WHERE o.order_group_id = ?
      `, [orderGroupId]);
      let message = `Group Order ID: ${orderGroupId}\n\n`;
      message += 'Orders:\n';
      orders.forEach(o => {
        message += `Order ${o.id} by ${o.worker_id === user.user_id ? 'Admin' : 'Worker'} - Status: ${o.status}\n`;
      });
      message += '\nOrder Items:\n';
      orderItems.forEach(oi => {
        message += `${oi.worker_name}: ${oi.item_name} x${oi.quantity} - ${oi.is_paid ? 'Paid' : 'Unpaid'}\n`;
      });
      await this.bot.sendMessage(chatId, message);
      await this.bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('updatestatus_')) {
      const orderGroupId = data.split('_')[1];
      const session = { action: 'UPDATE_GROUP_STATUS', orderGroupId };
      this.sessions.set(chatId, session);
      const options = {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Approve', callback_data: `groupstatus_approved_${orderGroupId}` }],
            [{ text: 'Reject', callback_data: `groupstatus_rejected_${orderGroupId}` }],
            [{ text: 'Complete', callback_data: `groupstatus_completed_${orderGroupId}` }]
          ]
        }
      };
      await this.bot.sendMessage(chatId, 'Select new status for group order:', options);
      await this.bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('groupstatus_')) {
      const [_, status, orderGroupId] = data.split('_');
      try {
        await this.pool.query('UPDATE orders SET status = ? WHERE order_group_id = ?', [status, orderGroupId]);
        await this.bot.sendMessage(chatId, `Group order ${orderGroupId} status updated to ${status}.`);
        this.sessions.delete(chatId);
      } catch (error) {
        this.logger.error('Error updating group order status:', error);
        await this.bot.sendMessage(chatId, 'Failed to update status.');
      }
      await this.bot.answerCallbackQuery(query.id);
    } else if (data.startsWith('managepayments_')) {
      const orderGroupId = data.split('_')[1];
      const [workers] = await this.pool.query(`
        SELECT 
          u.user_id,
          u.name AS worker_name,
          SUM(oi.quantity * mi.item_price) AS total_due,
          SUM(oi.is_paid) AS paid_status
        FROM order_items oi
        JOIN orders o ON oi.order_id = o.id
        JOIN users u ON oi.worker_id = u.user_id
        JOIN menu_items mi ON oi.menu_item_id = mi.id
        WHERE o.order_group_id = ?
        GROUP BY u.user_id
      `, [orderGroupId]);
      
      const options = {
        reply_markup: {
          inline_keyboard: workers.map(w => [
            { 
              text: `${w.worker_name} - $${w.total_due} (${w.paid_status ? 'Paid' : 'Unpaid'})`, 
              callback_data: `togglepayment_${orderGroupId}_${w.user_id}`
            }
          ])
        }
      };
      await this.bot.sendMessage(chatId, 'Select worker to toggle payment:', options);
    } else if (data.startsWith('togglepayment_')) {
      const [_, orderGroupId, workerId] = data.split('_');
      await this.pool.query(`
        UPDATE order_items 
        SET is_paid = NOT is_paid
        WHERE order_group_id = ? AND worker_id = ?
      `, [orderGroupId, workerId]);
      await this.bot.sendMessage(chatId, 'Payment status updated successfully!');
    }
  }

  async handleWorkerMessage(msg, user) {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (this.sessions.has(chatId)) {
      const session = this.sessions.get(chatId);
      if (session.action === 'PLACE_ORDER') {
        const input = text.trim();
        try {
          const items = input.split(',').map(i => {
            const [id, qty] = i.trim().split(':');
            return { id: parseInt(id), quantity: parseInt(qty) };
          });
          const [menuItems] = await this.pool.query('SELECT * FROM menu_items WHERE restaurant_id = ?', [session.restaurantId]);
          let total = 0;
          for (const item of items) {
            const menuItem = menuItems.find(mi => mi.id === item.id);
            if (!menuItem) throw new Error(`Item ${item.id} not found.`);
            if (item.quantity <= 0) throw new Error(`Invalid quantity for item ${item.id}`);
            total += menuItem.item_price * item.quantity;
          }
          const [order] = await this.pool.query('SELECT * FROM orders WHERE order_group_id = ?', [session.orderGroupId]);
          const orderId = order[0].id;
          await this.pool.query('START TRANSACTION');
          try {
            for (const item of items) {
              const menuItem = menuItems.find(mi => mi.id === item.id);
              await this.pool.query(
                'INSERT INTO order_items (order_id, menu_item_id, quantity, worker_id, order_group_id) VALUES (?, ?, ?, ?, ?)',
                [orderId, item.id, item.quantity, user.user_id, session.orderGroupId]
              );
            }
            await this.pool.query('COMMIT');
            await this.bot.sendMessage(chatId, `Order placed successfully! Total: $${total.toFixed(2)}`);
            this.sessions.delete(chatId);
          } catch (error) {
            await this.pool.query('ROLLBACK');
            this.logger.error('Order placement error:', error);
            await this.bot.sendMessage(chatId, 'Failed to place order. Please try again.');
          }
        } catch (error) {
          this.logger.error('Invalid order format:', error);
          await this.bot.sendMessage(chatId, error.message);
        }
      }
    } else {
      if (text === '/joinorder') {
        const [groupOrders] = await this.pool.query('SELECT * FROM orders WHERE is_admin_created = true');
        const options = {
          reply_markup: {
            inline_keyboard: groupOrders.map(o => [
              { text: `Group ID: ${o.order_group_id}`, callback_data: `join_${o.order_group_id}` }
            ])
          }
        };
        await this.bot.sendMessage(chatId, 'Select a group order to join:', options);
      } else if (text === '/viewmyorders') {
        const [orders] = await this.pool.query('SELECT * FROM orders WHERE worker_id = ?', [user.user_id]);
        if (orders.length === 0) {
          await this.bot.sendMessage(chatId, 'You have no orders.');
          return;
        }
        const message = orders.map(o => `
          Order ID: ${o.id}, Group ID: ${o.order_group_id}, Status: ${o.status}
        `).join('\n');
        await this.bot.sendMessage(chatId, `Your Orders:\n${message}`);
      }
    }
  }

  async handleWorkerCallback(query, user) {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith('join_')) {
      const orderGroupId = data.split('_')[1];
      const [orders] = await this.pool.query('SELECT * FROM orders WHERE order_group_id = ? AND is_admin_created = true', [orderGroupId]);
      if (orders.length === 0) {
        await this.bot.sendMessage(chatId, 'Invalid group order.');
        return;
      }
      const order = orders[0];
      const restaurantId = order.restaurant_id;
      this.sessions.set(chatId, { 
        action: 'PLACE_ORDER', 
        orderGroupId: orderGroupId,
        restaurantId: restaurantId
      });
      const [menuItems] = await this.pool.query('SELECT * FROM menu_items WHERE restaurant_id = ?', [restaurantId]);
      const menuText = menuItems.map(item => `${item.id}: ${item.item_name} - $${item.item_price}`).join('\n');
      await this.bot.sendMessage(chatId, `Menu for restaurant:\n${menuText}\nEnter items in format "ID:quantity" separated by commas:` );
      await this.bot.answerCallbackQuery(query.id);
    }
  }

  async getUserByTelegramId(telegramId) {
    try {
      const [rows] = await this.pool.query('SELECT * FROM users WHERE user_id = ?', [telegramId]);
      return rows[0] || null;
    } catch (error) {
      this.logger.error('Error fetching user:', error);
      return null;
    }
  }
}

const bot = new RestaurantOrderBot();
bot.start();