require("dotenv").config();
const { Sequelize, DataTypes } = require("sequelize");

// Connect to MySQL
const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
    host: process.env.DB_HOST,
    dialect: "mysql",
    logging: false,
});

// Define Models
const Company = sequelize.define("company", {
    name: { type: DataTypes.STRING, unique: true, allowNull: false },
});

const User = sequelize.define("user", {
    telegram_id: { type: DataTypes.BIGINT, unique: true, allowNull: false },
    role: { type: DataTypes.ENUM("admin", "worker"), allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
});

const Restaurant = sequelize.define("restaurant", {
    name: { type: DataTypes.STRING, allowNull: false },
    image_url: { type: DataTypes.STRING },
});

const MenuItem = sequelize.define("menu_item", {
    item_name: { type: DataTypes.STRING, allowNull: false },
    item_price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
});

const Order = sequelize.define("order", {
    status: {
        type: DataTypes.ENUM("pending", "approved", "rejected", "delivered"),
        defaultValue: "pending",
    },
});

const OrderItem = sequelize.define("order_item", {
    quantity: { type: DataTypes.INTEGER, allowNull: false },
});

// Define Relationships
Company.hasMany(User);
User.belongsTo(Company);

Company.hasMany(Restaurant);
Restaurant.belongsTo(Company);

Restaurant.hasMany(MenuItem);
MenuItem.belongsTo(Restaurant);

User.hasMany(Order);
Order.belongsTo(User);

Restaurant.hasMany(Order);
Order.belongsTo(Restaurant);

Order.hasMany(OrderItem);
OrderItem.belongsTo(Order);

MenuItem.hasMany(OrderItem);
OrderItem.belongsTo(MenuItem);

// Sync Database
sequelize.sync();

module.exports = { sequelize, User, Company, Restaurant, MenuItem, Order, OrderItem };
