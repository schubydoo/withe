"""Redact recorded CE responses into committable fixtures."""
import json, re, os, uuid

SRC='/tmp/rec'; DST='test/fixtures/ce'
os.makedirs(DST, exist_ok=True)

ORG='acme'
REPOS={'clauster':'widget','podspine':'gadget','claustrum':'sprocket','claustodian':'cog',
       'balenamcp':'lever','dump1090-exporter':'pulley','autohupr':'ratchet','renovate-config':'config'}
# Job ids are opaque; replace them with stable synthetic ones so a fixture diff
# stays readable and no real identifier is published.
JOBIDS={}
def jid(old):
    if old not in JOBIDS:
        JOBIDS[old]=str(uuid.UUID(int=len(JOBIDS)+1))
    return JOBIDS[old]

def scrub(text: str) -> str:
    text = text.replace('schubydoo', ORG)
    for real, fake in REPOS.items():
        text = re.sub(r'\b'+re.escape(real)+r'\b', fake, text)
    text = re.sub(r'\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b', '127.0.0.1:8080', text)
    text = re.sub(r'"installationId":\s*\d+', '"installationId": 100000000', text)
    text = re.sub(r'"pid":\s*\d+', '"pid": 1000', text)
    text = re.sub(r'"hostname":\s*"[^"]*"', '"hostname": "runner"', text)
    text = re.sub(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
                  lambda m: jid(m.group(0)), text)
    return text

# --- JSON responses -------------------------------------------------------
for name in ('orgs', 'repos', 'jobs-page1', 'jobs-page2'):
    data = json.loads(scrub(open(f'{SRC}/{name}.json').read()))
    json.dump(data, open(f'{DST}/{name}.json','w'), indent=2)
    open(f'{DST}/{name}.json','a').write('\n')

# --- the job log, trimmed to the lines Task 1.11 reads --------------------
KEEP = ('renovateVersion', 'updateSummary', 'branchesInformation', 'branches', 'branchList')
kept = []
for line in open(f'{SRC}/job.ndjson'):
    line = line.strip()
    if not line: continue
    try: obj = json.loads(line)
    except json.JSONDecodeError: continue
    is_abandoned = isinstance(obj.get('result'), dict) and obj['result'].get('isAbandoned')
    if any(k in obj for k in KEEP) or is_abandoned:
        kept.append(obj)

with open(f'{DST}/job.ndjson','w') as fh:
    for obj in kept:
        fh.write(scrub(json.dumps(obj)) + '\n')

print(f'log: {len(kept)} lines kept, {os.path.getsize(f"{DST}/job.ndjson")} bytes '
      f'(from {os.path.getsize(f"{SRC}/job.ndjson")})')
print('messages kept:', sorted({o.get('msg') for o in kept})[:8])

# --- second pass: synthetic commit hashes ---------------------------------
# 40-hex strings are branch SHAs and image digests. Neither is secret, but they
# are the author's, and the broad denylist rule that catches base64 secrets also
# catches these. Replace each with a stable synthetic hash of the same shape.
import hashlib
path=f'{DST}/job.ndjson'
text=open(path).read()
seen={}
def synth(m):
    old=m.group(0)
    if old not in seen:
        seen[old]=hashlib.sha1(f'withe-fixture-{len(seen)}'.encode()).hexdigest()
    return seen[old]
text=re.sub(r'\b[0-9a-f]{40}\b', synth, text)
open(path,'w').write(text)
print(f'redacted {len(seen)} commit hashes')
