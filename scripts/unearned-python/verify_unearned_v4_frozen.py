#!/usr/bin/env python3
"""Compare the unchanged engine and daily closes to frozen published V4 inputs."""
import gzip
import json
import os
from pathlib import Path
import sys
from datetime import date, timedelta
import pandas as pd
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from begifted_dashboard.unearned_google_sheet import GoogleServiceAccountGateway, _calculate_python_model
from begifted_dashboard.finance_reports import clean

os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = '/Users/kevinhsieh/Developer/BeGifted_Consulting_Materials/begifted-sheets-ab2b8e47aa86.json'
gateway = GoogleServiceAccountGateway()
source = '1AY6sAjw3rwAhdJCzMWR6qW0utBU91sv-JZWH1223mZc'
output = Path('outputs/unearned-v5/v4-frozen-parity.json.gz')
names = ['Model Status','IDX_Account','SRC_Credit_Balance','SRC_Credit_Event','Model Comparison','CALC_Account_Period','CALC_Student_Period']
ranges = ['A1:C200','A1:S1200','A1:N1200','A1:AC22000','A1:V30','A1:AC10000','A1:Y7000']
raw = dict(zip(names, gateway.batch_read_values(source, [f"'{name}'!{span}" for name,span in zip(names,ranges)])))
status = {r[0]:r[1] for r in raw['Model Status'][1:] if len(r)>1}
def asdate(value):
    return date(1899,12,30)+timedelta(days=float(value)) if isinstance(value,(int,float)) else date.fromisoformat(str(value)[:10])
def records(name):
    headers,*rows=raw[name]
    return [dict(zip(headers,row+['']*(len(headers)-len(row)))) for row in rows if row and row[0]!='']
cutoff=asdate(status['published_cutoff'])
accounts=records('IDX_Account')
balance={r['account_id']:r for r in records('SRC_Credit_Balance')}
for account in accounts:
    baseline=float(balance[account['account_id']]['baseline_credit_balance'])
    account.update(baseline_credit_balance=baseline,baseline_paid_credits=max(0,baseline),baseline_liability_thb=max(0,baseline)*float(account['selected_rate_thb']))
events=records('SRC_Credit_Event')
for event in events:
    event['event_date']=asdate(event['event_date'])
    if isinstance(event['event_timestamp'],(float,int)):
        event['event_timestamp']=pd.Timestamp('1899-12-30')+pd.Timedelta(days=event['event_timestamp'])
    else:event['event_timestamp']=pd.Timestamp(event['event_timestamp'])
engine_events,monthly,current,finance=_calculate_python_model(pd.DataFrame(accounts),pd.DataFrame(events),model_start=date(2026,3,1),cutoff=cutoff)
lookup={(min(r['month_end'],cutoff),r['account_id']):r for r in monthly.to_dict('records')}
max_difference=0
for row in records('CALC_Account_Period'):
    expected=float(row['legacy_closing_liability_thb'])
    actual=float(lookup[(asdate(row['period_end']),row['account_id'])]['closing_liability_thb'])
    max_difference=max(max_difference,abs(actual-expected))
# Independently project actual daily event closes and verify every published
# month-end/latest student and institution total from identical frozen inputs.
paid={r['account_id']:float(r['baseline_paid_credits']) for r in accounts}
rates={r['account_id']:float(r['selected_rate_thb']) for r in accounts}
student={r['account_id']:r['student_id'] for r in accounts}
byday={}
for event in engine_events.sort_values(['event_timestamp','event_key'],kind='stable').to_dict('records'):
    byday.setdefault(event['event_date'],[]).append(event)
for day in sorted(byday):
    if day<date(2026,3,1):
        for event in byday[day]:paid[event['account_id']]=event['closing_paid_credits']
expected_students={(asdate(r['period_end']),r['student_id']):float(r['legacy_closing_liability_thb']) for r in records('CALC_Student_Period')}
expected_finance={asdate(r['period_end']):float(r['legacy_closing_liability_thb']) for r in records('Model Comparison')}
day=date(2026,3,1);daily=[]
while day<=cutoff:
    for event in byday.get(day,[]):paid[event['account_id']]=event['closing_paid_credits']
    sums={}
    for key,quantity in paid.items():sums[student[key]]=sums.get(student[key],0)+quantity*rates[key]
    total=sum(sums.values())
    if day in expected_finance:
        max_difference=max(max_difference,abs(total-expected_finance[day]))
        for key,value in sums.items():max_difference=max(max_difference,abs(value-expected_students.get((day,key),0)))
    daily.append({'date':day.isoformat(),'liability_thb':total})
    day+=timedelta(days=1)
result={'status':'PASS' if max_difference<=1 else 'FAIL','cutoff':cutoff.isoformat(),'sourceRunId':records('Model Comparison')[0]['output_run_id'],'accountComparisons':len(records('CALC_Account_Period')),'studentComparisons':len(expected_students),'periodComparisons':len(expected_finance),'dailyCount':len(daily),'maximumDifferenceThb':max_difference,'toleranceThb':1}
with gzip.open(output,'wt',encoding='utf-8') as handle:json.dump(clean({'result':result,'frozenWorkbookValues':raw,'dailyReplay':daily}),handle,ensure_ascii=False)
os.chmod(output,0o600)
print(json.dumps(result))
if result['status']!='PASS':raise SystemExit(1)
