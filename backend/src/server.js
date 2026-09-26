require("dotenv").config();
const app = require("./app");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`SBAC backend rodando em http://localhost:${PORT}`);
});
