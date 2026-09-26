const fs = require('fs');
const path = require('path');

const databaseFile = process.env.QUICKFIX_DATABASE_FILE ||
  path.join(__dirname, '..', 'database', 'quickfix.json');
const databaseDirectory = path.dirname(databaseFile);

if (!fs.existsSync(databaseDirectory)) {
  fs.mkdirSync(databaseDirectory, { recursive: true });
}

if (!fs.existsSync(path.dirname(databaseFile))) {
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
}

if (!fs.existsSync(databaseFile)) {
  const initialDatabase = {
    providers: [],
    customers: [],
    leads: [],
    otp_sessions: [],
    conversations: [],
    messages: [],
    service_requests: []
  };

  fs.writeFileSync(
    databaseFile,
    JSON.stringify(initialDatabase, null, 2)
  );
}

function readDatabase() {
  const data = JSON.parse(fs.readFileSync(databaseFile, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('The QuickFix database must contain a JSON object');
  }

  let changed = false;

  for (const collection of [
    'providers',
    'customers',
    'leads',
    'otp_sessions',
    'conversations',
    'messages',
    'service_requests'
  ]) {
    if (!Object.prototype.hasOwnProperty.call(data, collection)) {
      data[collection] = [];
      changed = true;
    } else if (!Array.isArray(data[collection])) {
      throw new Error(`Database collection "${collection}" must be an array`);
    }
  }

  for (const provider of data.providers) {
    if (
      provider.verification_status === 'VERIFIED' &&
      !provider.availability
    ) {
      provider.availability = 'AVAILABLE';
      changed = true;
    }
  }

  if (changed) {
    writeDatabase(data);
  }

  return data;
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
