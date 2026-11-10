Self-signed certificate and disposable private key for the offline CONNECT/TLS
fixture in safe-dispatcher.test.ts. These are public test material, never a
production credential. Tests disable certificate trust verification deliberately;
SNI and end-to-end transport are still exercised.
