CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    role ENUM('admin', 'worker') NOT NULL,
    company_name VARCHAR(255) NOT NULL,
    UNIQUE(user_id)
);

CREATE TABLE restaurants (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    admin_id BIGINT NOT NULL,
    FOREIGN KEY (admin_id) REFERENCES users(user_id)
);

CREATE TABLE menu_items (
    id INT AUTO_INCREMENT PRIMARY KEY,
    restaurant_id INT NOT NULL,
    item_name VARCHAR(255) NOT NULL,
    item_price DECIMAL(10, 2) NOT NULL,
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
);

CREATE TABLE orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    worker_id BIGINT NOT NULL,
    restaurant_id INT NOT NULL,
    status ENUM('pending', 'approved', 'rejected', 'completed') NOT NULL,
    FOREIGN KEY (worker_id) REFERENCES users(user_id),
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
);