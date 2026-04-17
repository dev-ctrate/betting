const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("KIA DEKH RAHA HAI");
});

app.get("/odds", (req, res) => {
  res.json({
    edge: Math.random(),
    timestamp: new Date()
  });
});

app.listen(PORT, () => {
  console.log(⁠ "Server running on port " + PORT⁠);
});
