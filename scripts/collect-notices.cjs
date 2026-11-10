"use strict";

const fs = require("node:fs");
const path = require("node:path");
const lock = require("../package-lock.json");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "release", "notices");

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
fs.cpSync(path.join(root, "licenses"), output, { recursive: true });
fs.copyFileSync(path.join(root, "THIRD_PARTY.md"), path.join(output, "THIRD_PARTY.md"));

for (const [location, metadata] of Object.entries(lock.packages)) {
  if (!location || metadata.dev) continue;
  const source = path.join(root, location);
  if (!fs.existsSync(source)) continue;
  const pkg = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  const destination = path.join(output, "npm", ...pkg.name.split("/"), pkg.version);
  const files = fs.readdirSync(source, { withFileTypes: true }).filter(
    (file) => file.isFile() && /^(licen[cs]e|copying|notice)(\b|[._-])/i.test(file.name)
  );
  fs.mkdirSync(destination, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(source, file.name), path.join(destination, file.name));
  if (files.length === 0) {
    const repository = typeof pkg.repository === "object" ? pkg.repository.url : pkg.repository;
    fs.writeFileSync(path.join(destination, "package-notice.txt"), [
      pkg.name + "@" + pkg.version,
      "Declared license: " + (pkg.license || "see upstream"),
      repository || metadata.resolved || "",
      "",
    ].join("\n"));
  }
}
