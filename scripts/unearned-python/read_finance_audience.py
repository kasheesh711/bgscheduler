#!/usr/bin/env python3
"""Read the existing workbook audience without changing permissions or emailing."""
import json
import sys
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1]).resolve()))
from begifted_dashboard.unearned_google_sheet import GoogleServiceAccountGateway
gateway=GoogleServiceAccountGateway(sys.argv[2])
metadata=gateway.drive.files().get(fileId=sys.argv[3],fields='permissions(type,emailAddress,role)').execute(num_retries=3)
audience=[]
for permission in metadata.get('permissions',[]):
    if permission['role']=='owner':continue
    if permission.get('type') not in ['user','group'] or not permission.get('emailAddress'):
        raise SystemExit('Finance workbook has an unsupported public/domain permission; cannot mirror to a private audit folder')
    audience.append({'type':permission['type'],'emailAddress':permission['emailAddress'],'role':'writer' if permission['role']=='writer' else 'reader'})
if not audience:raise SystemExit('Could not verify existing Finance audience')
print(json.dumps(audience))
