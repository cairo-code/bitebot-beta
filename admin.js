const mysql = require('mysql2/promise');

class AdminActions {
  constructor(pool) {
    this.pool = pool;
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

  async viewAdminOrders(chatId) {
    // Implement admin order viewing logic here
  }

  async logout(chatId) {
    await this.bot.sendMessage(chatId, 'Logged out successfully.');
    await this.handleStart({ chat: { id: chatId } });
  }
}

module.exports = AdminActions;