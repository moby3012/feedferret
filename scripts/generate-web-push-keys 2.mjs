import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();

console.log("WEB_PUSH_VAPID_PUBLIC_KEY=\"" + keys.publicKey + "\"");
console.log("WEB_PUSH_VAPID_PRIVATE_KEY=\"" + keys.privateKey + "\"");
console.log('WEB_PUSH_CONTACT="mailto:admin@example.com"');
console.log("\nCopy these values into your deployment environment. The public key is safe to expose to the browser.");
