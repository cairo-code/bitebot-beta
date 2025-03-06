const mysql = require('mysql2/promise');


  const mysql = require('mysql2/promise');

  async function initializeDatabase(pool) {
    const connection = await pool.getConnection();
  
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
  
  module.exports = initializeDatabase;