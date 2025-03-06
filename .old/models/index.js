const { Sequelize } = require("sequelize");
const sequelize = require("../config/database");

// Import models and pass sequelize instance
const User = require("./user")(sequelize, Sequelize);
const Company = require("./company")(sequelize, Sequelize);
const Restaurant = require("./restaurant")(sequelize, Sequelize);
const Menu = require("./menu")(sequelize, Sequelize);
const Order = require("./order")(sequelize, Sequelize);

// Define associations
Company.hasMany(User, { foreignKey: "companyId", onDelete: "CASCADE" });
User.belongsTo(Company, { foreignKey: "companyId" });

Company.hasMany(Restaurant, { foreignKey: "companyId" });
Restaurant.belongsTo(Company, { foreignKey: "companyId" });

Restaurant.hasMany(Menu, { foreignKey: "restaurantId" });
Menu.belongsTo(Restaurant, { foreignKey: "restaurantId" });

User.hasMany(Order, { foreignKey: "userId" });
Order.belongsTo(User, { foreignKey: "userId" });

Restaurant.hasMany(Order, { foreignKey: "restaurantId" });
Order.belongsTo(Restaurant, { foreignKey: "restaurantId" });

// Sync database
(async () => {
  try {
    await sequelize.sync({ alter: true }); // Change to `force: true` if you want to reset tables
    console.log("✅ Database & tables synced successfully!");
  } catch (error) {
    console.error("❌ Error syncing database:", error);
  }
})();

module.exports = { sequelize, User, Company, Restaurant, Menu, Order };
