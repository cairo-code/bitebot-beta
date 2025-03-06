const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');

class UserRegistration {
  constructor(pool) {
    this.pool = pool;
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
}

module.exports = UserRegistration;