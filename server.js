app.post("/webhook", async (req, res) => {
  console.log("Full incoming body:");
  console.log(JSON.stringify(req.body, null, 2));

  const message = req.body?.payload?.payload?.text;
  const countryCode = req.body?.phone?.countryCode;
  const phone = req.body?.phone?.phone;

  if (!message) {
    console.log("No message found");
    return res.status(200).send("OK");
  }

  const fullNumber = countryCode + phone;

  console.log("Extracted message:", message);
  console.log("From:", fullNumber);

  res.status(200).send("OK");
});