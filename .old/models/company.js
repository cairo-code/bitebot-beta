const { Model, DataTypes } = require("sequelize");

class Company extends Model {}

Company.schema = {
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
};

module.exports = Company;
