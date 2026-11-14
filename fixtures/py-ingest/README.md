# tenant-ingest
A command-line pipeline that loads tenant billing exports in CSV form.
Each row is parsed, normalised, validated and deduplicated, then written to `accepted.csv` in batches.
Rows for archived tenants go to `archived.csv`, and rows that fail a check go to `rejects.csv`.
Run it with `python -m ingest.cli --out-dir out --archived acme,globex exports/*.csv`.
