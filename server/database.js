const fs = require('fs');
const path = require('path');

const databaseDirectory = path.join(__dirname, '..', 'database');
const databaseFile = path.join(databaseDirectory, 'quickfix.json');

if (!fs.existsSync(databaseDirectory)) {
  fs.mkdirSync(databaseDirectory, { recursive: true });
}

if (!fs.existsSync(databaseFile)) {
  const initialDatabase = {
    providers: [],
    customers: [],
    leads: [],
    otp_sessions: []
  };

  fs.writeFileSync(
    databaseFile,
    JSON.stringify(initialDatabase, null, 2)
  );
}

function readDatabase() {
  return JSON.parse(fs.readFileSync(databaseFile, 'utf8'));
}

function writeDatabase(data) {
  fs.writeFileSync(
    databaseFile,
    JSON.stringify(data, null, 2)
  );
}

console.log('QuickFix local database initialized.');

module.exports = {
  readDatabase,
  writeDatabase
};
