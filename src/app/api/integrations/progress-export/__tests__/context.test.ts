import {beforeEach,describe,it,expect,vi} from 'vitest';
import {PgDialect} from 'drizzle-orm/pg-core';
const mocks=vi.hoisted(()=>({execute:vi.fn(),identities:vi.fn()}));
vi.mock('@/lib/db',()=>({getDb:()=>({execute:mocks.execute})}));
vi.mock('@/lib/progress-tests/db',()=>({loadActiveIdentityEntries:mocks.identities}));
import {GET} from '../route';
describe('individual and shared lesson context',()=>{
 beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('PROGRESS_EXPORT_SECRET','s'.repeat(40));mocks.identities.mockResolvedValue([{canonicalKey:'A',wiseUserId:'teacher-a'}]);});
 it('exports a shared-session reason without other participants or their note content',async()=>{
  mocks.execute.mockResolvedValueOnce({rows:[{id:'individual',participant_count:1,canonical_tutor_key:'A',wise_teacher_user_id:'teacher-a',latest_feedback_version_id:'individual-note',source_status:'ready'},{id:'shared',participant_count:2,canonical_tutor_key:'A',wise_teacher_user_id:'teacher-a',latest_feedback_version_id:'private-shared-note',source_status:'ready'},{id:'wrong-identity',participant_count:1,canonical_tutor_key:'A',wise_teacher_user_id:'someone-else'}]}).mockResolvedValueOnce({rows:[{session_id:'individual'}]}).mockResolvedValueOnce({rows:[{id:'individual-note'}]});
  const response=await GET(new Request('https://source.test/api/integrations/progress-export?type=context',{headers:{authorization:`Bearer ${'s'.repeat(40)}`}}));
  expect(response.status).toBe(200);const body=await response.json();expect(body.sessions).toHaveLength(2);expect(body.sessions[1]).toMatchObject({id:'shared',source_status:'shared_context',latest_feedback_version_id:null});expect(JSON.stringify(body)).not.toContain('private-shared-note');expect(body.participants).toEqual([{session_id:'individual'}]);
  for(const [query] of mocks.execute.mock.calls.slice(1))expect(new PgDialect().sqlToQuery(query).params).toEqual(['["individual"]']);
 });
});
