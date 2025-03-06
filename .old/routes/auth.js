const express = require("express");
const bcrypt = require("bcryptjs");
const { User, Company } = require("../models");
const router = express.Router();

// Register User
router.post("/register", async (req, res) => {
  const { name, email, password, role, companyName, companyId } = req.body;

  try {
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    let company;

    if (role === "admin") {
      // Create a new company if registering as admin
      company = await Company.create({ name: companyName });
    } else if (role === "worker") {
      // Ensure the selected company exists
      company = await Company.findByPk(companyId);
      if (!company) return res.status(400).json({ message: "Company not found" });
    } else {
      return res.status(400).json({ message: "Invalid role" });
    }

    // Create the user
    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      role,
      companyId: company.id,
    });

    res.status(201).json({ message: "User registered successfully", user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
