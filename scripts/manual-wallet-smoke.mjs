import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const baseUrl=(process.env.BASE_URL||'http://127.0.0.1:8788').replace(/\/$/,'');
const origin=new URL(baseUrl).origin;
const runId=randomUUID().slice(0,8);
const password='Manual-Wallet-QA-2026!';
async function raw(path,{account,method='GET',body}={}){
 const headers={accept:'application/json'};
 if(account?.cookie)headers.cookie=account.cookie;
 if(method!=='GET'){headers['content-type']='application/json';headers.origin=origin;}
 return fetch(baseUrl+path,{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function request(path,options={}){
 const response=await raw(path,options);const data=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(options.method+' '+path+' returned '+response.status+': '+(data.error||'unknown error'));
 return data;
}
async function expectStatus(path,status,options={}){
 const response=await raw(path,options);const data=await response.json().catch(()=>({}));
 assert.equal(response.status,status,path+' expected HTTP '+status+' but received '+response.status+': '+(data.error||''));
 return data;
}
async function register(label){
 const email='manual-wallet-'+runId+'-'+label+'@example.test';
 const data=await request('/api/auth/register',{method:'POST',body:{name:'Wallet QA '+label,email,password}});
 const account={email,id:data.user.id,memberId:data.user.memberId};
 const login=await raw('/api/auth/login',{method:'POST',body:{email,password}});
 assert.equal(login.status,200);
 account.cookie=(login.headers.get('set-cookie')||'').split(';',1)[0];
 assert.match(account.cookie,/^dabernaz_session=[0-9a-f]{64}$/i);
 return account;
}
async function me(account){return (await request('/api/auth/me',{account})).user;}

const admin=await register('admin');
const customer=await register('customer');
const other=await register('other');
const adminEmail=admin.email.replace(/'/g,"''");
const customerEmail=customer.email.replace(/'/g,"''");
execFileSync('wrangler',['d1','execute','dabernaz-ci','--local','--persist-to','.wrangler/test-state','--command',
 "UPDATE users SET member_id='999999' WHERE email='"+adminEmail+"'; UPDATE users SET balance=200000 WHERE email='"+customerEmail+"';"],
 {stdio:'inherit'});
admin.memberId='999999';
assert.equal(String((await me(admin)).memberId),'999999');
assert.equal(Number((await me(customer)).balance),200000);

await expectStatus('/api/admin/wallet',403,{account:customer});
await expectStatus('/api/wallet/requests',400,{account:customer,method:'POST',body:{type:'deposit',amount:104}});
await expectStatus('/api/wallet/requests',400,{account:customer,method:'POST',body:{type:'withdraw',amount:204,cardNumber:'9876543298765432',cardHolder:'Wallet QA Customer'}});
const inbox=await request('/api/admin/wallet',{account:admin});
assert.equal(inbox.isAdmin,true);
assert.deepEqual(inbox.requests,[]);
const settings=await request('/api/admin/wallet/settings',{account:admin});
assert.equal(settings.ok,true);
const saved=await request('/api/admin/wallet/settings',{account:admin,method:'POST',body:{
 cardNumber:'1234567812345678',cardHolder:'Wallet QA Holder',bankName:'بانک آزمون',paymentNote:'رسید را واضح ارسال کن.'
}});
assert.equal(saved.settings.cardNumber,'1234567812345678');
await expectStatus('/api/wallet/payment-info',405,{account:customer});

const deposit=await request('/api/wallet/requests',{account:customer,method:'POST',body:{type:'deposit',amount:50000,userNote:'کد پیگیری آزمایشی 50000'}});
assert.ok(deposit.requestId>0);
assert.equal(deposit.status,'awaiting_receipt');
const customerRequests=await request('/api/wallet/requests',{account:customer});
assert.equal(customerRequests.requests[0].status,'awaiting_receipt');
assert.equal(customerRequests.requests[0].user_note,'کد پیگیری آزمایشی 50000');
assert.ok(!('card_number' in customerRequests.requests[0]),'customer wallet responses must not expose destination card numbers');
assert.ok(!('card_holder' in customerRequests.requests[0]),'customer wallet responses must not expose destination card holders');
assert.ok(!('payment_card_number' in customerRequests.requests[0]),'customer wallet responses must not expose payment card snapshots');
const paymentInfo=await request('/api/wallet/requests/'+deposit.requestId+'/payment-instructions',{account:customer});
assert.equal(paymentInfo.paymentInfo.cardNumber,'1234567812345678');
assert.equal(paymentInfo.paymentInfo.cardHolder,'Wallet QA Holder');
await expectStatus('/api/wallet/requests/'+deposit.requestId+'/payment-instructions',404,{account:other});
await expectStatus('/api/wallet/requests/'+deposit.requestId+'/payment-instructions',401);
const sentByCustomer=await request('/api/wallet/messages',{account:customer,method:'POST',body:{message:'برای واریز لطفاً شماره کارت را ارسال کنید.'}});
assert.ok(sentByCustomer.message?.id>0);
assert.deepEqual((await request('/api/wallet/messages',{account:other})).messages,[],'a different customer must not read another account conversation');
await expectStatus('/api/admin/wallet/messages?member_id='+encodeURIComponent(customer.memberId),403,{account:customer});
await expectStatus('/api/admin/wallet/messages',403,{account:customer,method:'POST',body:{memberId:customer.memberId,message:'ارسال غیرمجاز'}});
const adminThread=await request('/api/admin/wallet/messages?member_id='+encodeURIComponent(customer.memberId),{account:admin});
assert.equal(adminThread.messages.length,1);
assert.equal(adminThread.messages[0].sender_type,'user');
await request('/api/admin/wallet/messages',{account:admin,method:'POST',body:{memberId:customer.memberId,message:'شماره کارت آزمایشی: 1234567812345678'}});
const customerThread=await request('/api/wallet/messages',{account:customer});
assert.deepEqual(customerThread.messages.map(message=>message.sender_type),['user','admin']);
assert.match(customerThread.messages[1].message,/1234567812345678/,'the customer must receive the finance admin reply privately');
assert.equal((await request('/api/wallet/requests',{account:other})).requests.length,0);
await expectStatus('/api/wallet/requests/'+deposit.requestId+'/receipt',404,{account:other,method:'POST',body:{dataUrl:'data:image/png;base64,'+Buffer.from('receipt-proof-payload-'.repeat(10)).toString('base64')}});
const fakePng='data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.from('X'.repeat(220))]).toString('base64');
const uploaded=await request('/api/wallet/requests/'+deposit.requestId+'/receipt',{account:customer,method:'POST',body:{dataUrl:fakePng}});
assert.equal(uploaded.status,'pending_review');
await expectStatus('/api/wallet/requests/'+deposit.requestId+'/payment-instructions',409,{account:customer});
const pending=await request('/api/admin/wallet?status=pending_review',{account:admin});
assert.equal(pending.requests.length,1);
assert.equal(pending.requests[0].has_receipt,1);
const detail=await request('/api/admin/wallet/'+deposit.requestId,{account:admin});
assert.ok(detail.request.receiptDataUrl.startsWith('data:image/png;base64,'));
assert.equal(detail.request.username,'Wallet QA customer');
await request('/api/admin/wallet/'+deposit.requestId+'/decision',{account:admin,method:'POST',body:{decision:'approve',note:'رسید بررسی شد'}});
assert.equal(Number((await me(customer)).balance),250000);
await expectStatus('/api/admin/wallet/'+deposit.requestId+'/decision',409,{account:admin,method:'POST',body:{decision:'approve'}});
assert.equal(Number((await me(customer)).balance),250000,'deposit approval must credit exactly once');

const withdraw=await request('/api/wallet/requests',{account:customer,method:'POST',body:{
 type:'withdraw',amount:30000,cardNumber:'9876543298765432',cardHolder:'Wallet QA Customer',bankName:'بانک مقصد',userNote:'برداشت آزمایشی با توضیح'
}});
assert.equal(withdraw.status,'pending_transfer');
assert.equal(Number((await me(customer)).balance),220000,'withdrawal request must reserve the amount immediately');
const withdrawDetail=await request('/api/admin/wallet/'+withdraw.requestId,{account:admin});
assert.equal(withdrawDetail.request.card_number,'9876543298765432');
assert.equal(withdrawDetail.request.card_holder,'Wallet QA Customer');
assert.equal(withdrawDetail.request.user_note,'برداشت آزمایشی با توضیح');
await request('/api/admin/wallet/'+withdraw.requestId+'/decision',{account:admin,method:'POST',body:{decision:'paid'}});
assert.equal(Number((await me(customer)).balance),220000,'marking a reserved withdrawal paid must not debit twice');

const rejectedWithdraw=await request('/api/wallet/requests',{account:customer,method:'POST',body:{
 type:'withdraw',amount:20000,cardNumber:'9876543298765432',cardHolder:'Wallet QA Customer'
}});
assert.equal(Number((await me(customer)).balance),200000);
await request('/api/admin/wallet/'+rejectedWithdraw.requestId+'/decision',{account:admin,method:'POST',body:{decision:'reject',note:'مشخصات کارت نیاز به اصلاح دارد'}});
assert.equal(Number((await me(customer)).balance),220000,'rejected withdrawal must refund the reserved amount exactly once');
await expectStatus('/api/wallet/requests',409,{account:customer,method:'POST',body:{type:'withdraw',amount:500000,cardNumber:'9876543298765432',cardHolder:'Wallet QA Customer'}});
// Non-owner cannot attach proof to another customer's deposit.
await expectStatus('/api/wallet/requests/'+deposit.requestId+'/receipt',404,{account:other,method:'POST',body:{dataUrl:fakePng}});

const search=await request('/api/admin/wallet/users?q='+encodeURIComponent(customer.memberId),{account:admin});
assert.ok(search.users.some(u=>String(u.member_id)===String(customer.memberId)));
const adjustment=await request('/api/admin/wallet/adjust',{account:admin,method:'POST',body:{memberId:customer.memberId,amount:15000,reason:'اصلاح آزمایشی موجودی'}});
assert.equal(Number(adjustment.user.balance),235000);
assert.equal(Number((await me(customer)).balance),235000);
await expectStatus('/api/admin/wallet/adjust',409,{account:admin,method:'POST',body:{memberId:customer.memberId,amount:-999999,reason:'کاهش بیش از موجودی'}});
const tx=await me(customer);
assert.ok(tx.transactions.some(t=>t.title.includes('شارژ دستی کیف پول')&&Number(t.amount)===50000));
assert.ok(tx.transactions.some(t=>t.title.includes('بازگشت وجه برداشت ردشده')&&Number(t.amount)===20000));
assert.ok(tx.transactions.some(t=>t.title.includes('اصلاح موجودی توسط مدیر')&&Number(t.amount)===15000));

// Boundary checks: exactly 105 toman for deposit and 205 toman for withdrawal are accepted.
const minimumDeposit=await request('/api/wallet/requests',{account:customer,method:'POST',body:{type:'deposit',amount:105,userNote:'حداقل واریز'}});
assert.equal(minimumDeposit.status,'awaiting_receipt');
const minimumPayment=await request('/api/wallet/requests/'+minimumDeposit.requestId+'/payment-instructions',{account:customer});
assert.equal(minimumPayment.paymentInfo.cardNumber,'1234567812345678');
const minReceipt=await request('/api/wallet/requests/'+minimumDeposit.requestId+'/receipt',{account:customer,method:'POST',body:{dataUrl:fakePng}});
assert.equal(minReceipt.status,'pending_review');
await request('/api/admin/wallet/'+minimumDeposit.requestId+'/decision',{account:admin,method:'POST',body:{decision:'approve',note:'حداقل واریز آزمون شد'}});
assert.equal(Number((await me(customer)).balance),235105,'a 105-toman deposit must credit exactly 105 toman');

const minimumWithdraw=await request('/api/wallet/requests',{account:customer,method:'POST',body:{
 type:'withdraw',amount:205,cardNumber:'9876543298765432',cardHolder:'Wallet QA Customer',bankName:'بانک مقصد',userNote:'حداقل برداشت'
}});
assert.equal(minimumWithdraw.status,'pending_transfer');
assert.equal(Number((await me(customer)).balance),234900,'a 205-toman withdrawal must reserve exactly 205 toman');
const minimumWithdrawDetail=await request('/api/admin/wallet/'+minimumWithdraw.requestId,{account:admin});
assert.equal(minimumWithdrawDetail.request.user_note,'حداقل برداشت');
await request('/api/admin/wallet/'+minimumWithdraw.requestId+'/decision',{account:admin,method:'POST',body:{decision:'paid'}});
assert.equal(Number((await me(customer)).balance),234900,'marking the minimum withdrawal paid must not debit twice');

const adminList=await request('/api/admin/wallet',{account:admin});
assert.ok(adminList.requests.length>=3);
const customerList=await request('/api/wallet/requests',{account:customer});
assert.ok(customerList.requests.some(r=>r.id===deposit.requestId&&r.status==='approved'));
assert.ok(customerList.requests.some(r=>r.id===withdraw.requestId&&r.status==='paid'));
assert.ok(customerList.requests.some(r=>r.id===rejectedWithdraw.requestId&&r.status==='rejected'));
console.log('Manual wallet smoke test passed: admin authorization, payment settings, deposit proof privacy, exactly-once deposit credit, withdrawal reserve/paid/refund, admin balance adjustment, and ledger history.');
