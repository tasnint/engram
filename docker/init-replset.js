// Runs on every `pnpm db:up`: starts the replica set if it isn't yet, and
// creates the user mongot syncs data with. Safe to run repeatedly.
const NOT_YET_INITIALIZED = 94;
const ALREADY_INITIALIZED = 23;

let initialized = false;
while (!initialized) {
  try {
    rs.status();
    initialized = true;
  } catch (error) {
    if (error.code !== NOT_YET_INITIALIZED) {
      // mongod is still starting up; try again shortly.
      sleep(500);
      continue;
    }
    try {
      rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "mongod:27017" }] });
    } catch (initError) {
      if (initError.code !== ALREADY_INITIALIZED) throw initError;
    }
    initialized = true;
  }
}
while (!db.hello().isWritablePrimary) sleep(250);

const admin = db.getSiblingDB("admin");
if (!admin.getUser("mongotUser")) {
  admin.createUser({
    user: "mongotUser",
    pwd: require("fs").readFileSync("/run/secrets/mongot-password", "utf8"),
    roles: [{ role: "searchCoordinator", db: "admin" }],
  });
}
print("replica set ready");
