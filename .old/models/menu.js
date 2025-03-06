const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  return sequelize.define('menu', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    restaurantId: { type: DataTypes.INTEGER },
    itemName: { type: DataTypes.STRING, allowNull: false },
    itemPrice: { type: DataTypes.FLOAT, allowNull: false }
  }, { timestamps: false });
};
