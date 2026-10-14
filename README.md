# Unified UBC Data

Public University of British Columbia data in JSON, CSV, GeoJSON and Markdown:
courses, admissions, fees, campus locations, services and articles. No individual
student records. Aggregate grades come from a third-party mirror.

## Start here

Use Node 24 or newer:

```sh
npm ci
npm run update -- --list
npm run collect:prose -- --list
```

Refresh selected collections:

```sh
npm run update -- courses events
npm run collect:prose -- workday
```

| Collection          | Index                                                                                |
| ------------------- | ------------------------------------------------------------------------------------ |
| Structured datasets | [`data/catalog.json`](data/catalog.json), [`data/manifest.json`](data/manifest.json) |
| Prose articles      | [`data/prose/_catalog.json`](data/prose/_catalog.json)                               |
| Host articles       | [`data/official-hosts.json`](data/official-hosts.json)                               |

Check source URLs and retrieval dates before using fees, rules or availability.
Vancouver is the default campus; coverage varies by source. Keep provenance fields
and use a safe Markdown renderer.

## Documentation

- [Querying](docs/querying.md): formats, joins and examples.
- [Collecting](docs/collecting.md): refresh commands, source quirks and development checks.
- [Host collection](docs/hosts.md): admission, private recording and publication.
