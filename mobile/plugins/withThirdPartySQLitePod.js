const { withPodfileProperties } = require("expo/config-plugins");

module.exports = function withThirdPartySQLitePod(config) {
  return withPodfileProperties(config, (config) => {
    config.modResults["expo.updates.useThirdPartySQLitePod"] = "true";
    return config;
  });
};
