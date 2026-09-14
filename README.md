# Survey DApp

> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source code is provided for research, experimentation, and developer education only. This code has not been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete features. Use at your own risk.

Decentralized survey application on Polkadot. Create surveys, collect responses, and view results — all on-chain.

## How it works

- **Surveys** are stored as JSON on the Bulletin Chain and get a content-addressed CID.
- A **smart contract** on Asset Hub indexes survey CIDs and links response CIDs to them.
- **Responses** are also stored on Bulletin, with their CIDs recorded in the contract.
- To view results, the app reads all response CIDs from the contract, fetches the data from Bulletin, and aggregates the answers.

## Setup

```bash
./setup.sh
npm run dev
```

Open the app inside a Polkadot host, including during localhost development.
Chain reads and writes require that host to support the selected Asset Hub.
Bulletin reads use host preimage subscriptions and validate the content against
the raw BLAKE2b-256 CIDs produced by survey uploads. Host unavailability is
reported; the app does not fall back to direct RPC or public storage gateways.

Run `npm test` for isolated host-boundary regressions and `npm run build:frontend`
for the TypeScript check and production build. These checks do not replace a
real-host create/respond smoke test.

> Deploying **your own copy** (own contract, own `.dot` name, published to the
> playground)? Follow the step-by-step [DEPLOYMENT.md](./DEPLOYMENT.md).

## Security

This is a reference proof-of-concept, **not a hardened production build**. Before
deploying it for any real use case, you are responsible for:

- Reviewing the code yourself.
- Checking that dependencies are up to date and free of known vulnerabilities.
- Securing your own fork or deployment environment (keys, secrets, network configuration).
- Tracking the latest tagged release / commits for security fixes — older releases
  are not backported (exceptions might apply).

For Parity's security disclosure process and Bug Bounty program, see
[parity.io/bug-bounty](https://parity.io/bug-bounty).

## License

Licensed under the [GNU General Public License v3.0](./LICENSE) (GPL-3.0-only).
