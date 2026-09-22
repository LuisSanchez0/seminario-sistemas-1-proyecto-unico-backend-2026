require("dotenv").config();

const config = {
  mongodb: {
    url: process.env.MONGODB_CNN,
    options: {
      serverSelectionTimeoutMS: 10000
    }
  },

  migrationsDir: "migrations",
  changelogCollectionName: "changelog",
  lockCollectionName: "changelog_lock",
  lockTtl: 0,
  migrationFileExtension: ".js",
  useFileHash: false,
  moduleSystem: "commonjs"
};

module.exports = config;