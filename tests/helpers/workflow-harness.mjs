import { loadTypescript } from "./load-typescript.mjs";

// Stateful test double for SQL/storage. Business route code is real; this does
// not claim to test MySQL locks, migrations, or a production database.
export async function workflowHarness() {
  const users = Object.fromEntries([['admin','admin'],['supervisor-a','supervisor'],['supervisor-b','supervisor'],['employee-a','employee'],['employee-b','employee']].map(([id,role])=>[id,{id,role,fullName:id}]));
  const requests = new Map(['a','b'].map(suffix=>[`request-${suffix}`,{id:`request-${suffix}`,missionId:`mission-${suffix}`,missionTitle:'fixture',missionStatus:'follow_up',employeeId:`employee-${suffix}`,employeeName:'fixture',supervisorId:`supervisor-${suffix}`,assignedTo:`supervisor-${suffix}`,status:'awaiting_employee'}]));
  const messages = new Map(), attachments = new Map(), files = new Map(), notifications = [], audits = [];
  const itemForMission = id => [...requests.values()].find(item=>item.missionId===id);
  let tail=Promise.resolve();
  const db = {
    prepare(sql) {
      const statement = {
        sql,args:[],bind(...args){return {...this,args};},
        async first(){
          const a=this.args;
          if(sql.includes('FROM attachments')){const file=attachments.get(a[0]);const item=file&&itemForMission(file.missionId);return file&&{...file,assignedTo:item.employeeId,assigneeSupervisorId:item.supervisorId};}
          if(sql.includes('FROM mission_follow_up_messages fm JOIN')){const message=messages.get(a[0]);const item=message&&requests.get(message.requestId);return message&&{senderId:message.senderId,missionId:item.missionId,status:item.status};}
          if(sql.includes('FROM mission_follow_up_messages WHERE'))return messages.get(a[0])??null;
          if(sql.includes('FROM mission_follow_up_requests r'))return requests.get(a[0])??null;
          if(sql.includes('FROM missions m JOIN users')){const item=itemForMission(a[0]);return item&&{assignedTo:item.employeeId,assigneeSupervisorId:item.supervisorId,status:item.missionStatus};}
          throw new Error(`Unexpected test SQL: ${sql.slice(0,60)}`);
        },
        async all(){throw new Error('Unexpected all query');},
        async run(){
          const a=this.args;
          if(sql.startsWith('INSERT INTO mission_follow_up_messages'))messages.set(a[0],{id:a[0],requestId:a[1],senderId:a[2],body:a[3],createdAt:a[4]});
          else if(sql.startsWith('UPDATE mission_follow_up_requests')){const item=requests.get(a[1]);if(sql.includes("status = 'awaiting_supervisor'")){item.status='awaiting_supervisor';item.assignedTo=item.supervisorId;}}
          else if(sql.startsWith('INSERT INTO audit_logs'))audits.push(a);
          else if(sql.startsWith('INSERT INTO attachments'))attachments.set(a[0],{id:a[0],missionId:a[1],uploadedBy:a[2],objectKey:a[3],fileName:a[4],contentType:a[5],sizeBytes:a[6],messageId:a[7]});
          else throw new Error(`Unexpected mutation SQL: ${sql.slice(0,60)}`);
          return {meta:{changes:1}};
        },
      };
      return statement;
    },
    async batch(statements){return Promise.all(statements.map(statement=>statement.run()));},
    transaction(work){const result=tail.then(()=>work(db));tail=result.catch(()=>{});return result;},
  };
  const auth={requireRole:async(request,roles)=>{
    const user=users[request.headers.get('x-test-user')];
    if(!user)return {error:Response.json({error:'unauthorized'},{status:401})};
    if(!roles.includes(user.role))return {error:Response.json({error:'forbidden'},{status:403})};
    const expected=request.headers.get('x-tapra-user-id');
    if(expected&&expected!==user.id)return {error:Response.json({code:'ACCOUNT_CONTEXT_CHANGED'},{status:409})};
    return {user};
  }};
  const storage={fileStorage:{put:async(key,bytes)=>files.set(key,bytes),get:async key=>files.has(key)?{body:files.get(key)}:null,delete:async key=>files.delete(key)}};
  const followUp = await loadTypescript(new URL('../../lib/follow-up.ts',import.meta.url));
  const messageRoute = await loadTypescript(new URL('../../app/api/follow-up-requests/[id]/messages/route.ts',import.meta.url),{
    '../../../../../db/runtime':{ensureDatabase:async()=>db},'../../../../../lib/auth':auth,'../../../../../lib/follow-up':followUp,
    '../../../../../lib/push-notifications':{createUserNotification:async(userId,input)=>notifications.push({userId,...input})},
  });
  const uploadRoute = await loadTypescript(new URL('../../app/api/attachments/route.ts',import.meta.url),{'../../../db/runtime':{ensureDatabase:async()=>db},'../../../lib/auth':auth,'../../../lib/file-storage':storage});
  const fileRoute = await loadTypescript(new URL('../../app/api/attachments/[id]/route.ts',import.meta.url),{'../../../../db/runtime':{ensureDatabase:async()=>db},'../../../../lib/auth':auth,'../../../../lib/file-storage':storage});
  const headers = (user,extra={})=>({'x-test-user':user,'X-Tapra-User-Id':user,...extra});
  return {requests,messages,attachments,notifications,audits,
    send:(user,id,body,extra={})=>messageRoute.POST(new Request(`http://fixture/api/follow-up-requests/${id}/messages`,{method:'POST',headers:headers(user,extra),body:JSON.stringify(body)}),{params:Promise.resolve({id})}),
    upload:(user,missionId,messageId)=>{const form=new FormData();form.set('missionId',missionId);form.set('messageId',messageId);form.set('file',new File(['fixture'],'file.txt',{type:'text/plain'}));return uploadRoute.POST(new Request('http://fixture/api/attachments',{method:'POST',headers:headers(user),body:form}));},
    download:(user,id)=>fileRoute.GET(new Request(`http://fixture/api/attachments/${id}`,{headers:headers(user)}),{params:Promise.resolve({id})}),
  };
}
