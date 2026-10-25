// Runs once per fresh volume (and harmlessly on every start after that):
// starts the replica set and creates the user mongot syncs data with.
try {
  rs.status();
} catch {
  rs.initiate({ _id: "rs0", members: [{ _id: 0, host: "mongod:27017" }] });
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
