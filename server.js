const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;

// basic route
app.get("/", (req, res) => {
  res.send("Live Odds Tracker is running");
});

// example API route (you’ll expand this later)
app.get("/odds", (req, res) => {
  res.json({
    edge: Math.random(),
    timestamp: new Date()
  });
});
