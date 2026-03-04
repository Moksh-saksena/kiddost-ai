const nextPWA = require("next-pwa");

const withPWA = nextPWA({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
});

module.exports = withPWA({});