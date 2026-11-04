<?php
/* Dabernaz PHP API fallback for standard cPanel hosting. */
declare(strict_types=1);

$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
session_name('dabernaz_php_session');
ini_set('session.gc_maxlifetime', (string)(60 * 60 * 24 * 30));
ini_set('session.cookie_lifetime', (string)(60 * 60 * 24 * 30));
session_set_cookie_params([
    'lifetime' => 60 * 60 * 24 * 30,
    'path' => '/',
    'secure' => $https,
    'httponly' => true,
    'samesite' => 'Strict',
]);
session_start();

const DABERNAZ_CAPACITY = 20;
const DABERNAZ_DRAW_INTERVAL = 3;
$privateDir = __DIR__ . '/.private';
$dbFile = $privateDir . '/store-php.json';
$lockFile = $privateDir . '/store-php.lock';

function send_json(int $status, array $data): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, private');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function request_body(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > 32768) send_json(413, ['error' => 'درخواست بیش از حد بزرگ است.']);
    if ($raw === '') return [];
    $value = json_decode($raw, true);
    if (!is_array($value)) send_json(400, ['error' => 'داده ارسالی معتبر نیست.']);
    return $value;
}
function text_length(string $value): int {
    $count = preg_match_all('/./us', $value, $matches);
    return $count === false ? strlen($value) : $count;
}
function public_user(array $user): array {
    return [
        'id' => $user['id'], 'name' => $user['name'], 'email' => $user['email'],
        'memberId' => $user['memberId'], 'createdAt' => $user['createdAt'],
        'stats' => $user['stats'] ?? ['gamesPlayed' => 0, 'wins' => 0, 'points' => 0],
        'bingoCoins' => (int)($user['bingoCoins'] ?? 0),
        'coinTransactions' => array_slice($user['coinTransactions'] ?? [], 0, 50),
    ];
}
function fresh_room(string $id): array {
    return ['id'=>$id,'status'=>'waiting','queue'=>[],'cardCounts'=>[],'queuedCards'=>[],'players'=>[],
        'calledNumbers'=>[],'winners'=>['line'=>null,'full'=>null],'startedAt'=>null,'finishedAt'=>null,
        'nextDrawAt'=>null,'updatedAt'=>time()];
}
function random_int_safe(int $min, int $max): int { return random_int($min, $max); }
function make_card(): array {
    $grid = array_fill(0, 3, array_fill(0, 9, false));
    for ($r=0; $r<3; $r++) {
        $cols = range(0, 8); shuffle($cols);
        foreach (array_slice($cols, 0, 5) as $c) $grid[$r][$c] = true;
    }
    $counts = array_fill(0, 9, 0);
    for ($c=0; $c<9; $c++) for ($r=0; $r<3; $r++) if ($grid[$r][$c]) $counts[$c]++;
    for ($missing=0; $missing<9; $missing++) {
        if ($counts[$missing] > 0) continue;
        $moves=[];
        for ($r=0; $r<3; $r++) if (!$grid[$r][$missing]) {
            for ($donor=0; $donor<9; $donor++) if ($grid[$r][$donor] && $counts[$donor] > 1) $moves[]=[$r,$donor];
        }
        if (!$moves) throw new RuntimeException('ساخت کارت معتبر ممکن نشد.');
        [$r,$donor] = $moves[random_int(0, count($moves)-1)];
        $grid[$r][$donor]=false; $grid[$r][$missing]=true; $counts[$donor]--; $counts[$missing]++;
    }
    $card = array_map(fn($row) => array_map(fn($v) => $v ? 0 : null, $row), $grid);
    for ($c=0; $c<9; $c++) {
        $min = $c===0 ? 1 : $c*10;
        $max = $c===8 ? 90 : $c*10+9;
        $places=[];
        for ($r=0; $r<3; $r++) if ($card[$r][$c] === 0) $places[]=$r;
        $values=range($min,$max); shuffle($values); $values=array_slice($values,0,count($places)); sort($values);
        foreach ($places as $i=>$r) $card[$r][$c]=$values[$i];
    }
    return $card;
}
function line_complete(array $card, array $called): bool {
    $set = array_fill_keys($called, true);
    foreach ($card as $row) {
        $numbers = array_values(array_filter($row, fn($n) => is_int($n)));
        if (count($numbers) === 5 && count(array_filter($numbers, fn($n) => isset($set[$n]))) === 5) return true;
    }
    return false;
}
function full_complete(array $card, array $called): bool {
    $numbers=[]; foreach ($card as $row) foreach ($row as $n) if (is_int($n)) $numbers[]=$n;
    if (count($numbers)!==15) return false;
    $set=array_fill_keys($called,true);
    foreach ($numbers as $n) if (!isset($set[$n])) return false;
    return true;
}
function finish_room(array &$room): void {
    $room['status']='finished'; $room['finishedAt']=time(); $room['updatedAt']=time(); $room['nextDrawAt']=null;
}
function start_room(array &$room, array $db): void {
    $players=[];
    foreach ($room['queue'] as $userId) {
        $user=null; foreach ($db['users'] as $candidate) if ($candidate['id']===$userId) { $user=$candidate; break; }
        if (!$user) continue;
        $players[]=['userId'=>$userId,'name'=>$user['name'],'memberId'=>$user['memberId'],'cards'=>$room['queuedCards'][$userId] ?? [make_card()]];
    }
    $room['players']=$players; $room['queue']=[]; $room['queuedCards']=[]; $room['status']='playing';
    $room['calledNumbers']=[]; $room['winners']=['line'=>null,'full'=>null]; $room['startedAt']=time();
    $room['finishedAt']=null; $room['nextDrawAt']=time()+DABERNAZ_DRAW_INTERVAL; $room['updatedAt']=time();
}
function award_bingo_coin(array &$db, string $userId, int $amount, string $title): void {
    foreach ($db['users'] as &$user) if (($user['id'] ?? '') === $userId) {
        $user['bingoCoins'] = min(1000000000, (int)($user['bingoCoins'] ?? 0) + $amount);
        $user['coinTransactions'] = $user['coinTransactions'] ?? [];
        array_unshift($user['coinTransactions'], ['amount'=>$amount,'title'=>$title,'date'=>gmdate('c')]);
        $user['coinTransactions'] = array_slice($user['coinTransactions'], 0, 50);
        break;
    }
    unset($user);
}
function advance_room(array &$room, array &$db): void {
    if (($room['status'] ?? '') !== 'playing') return;
    $now=time(); $guard=0;
    while ($room['status']==='playing' && !empty($room['nextDrawAt']) && $room['nextDrawAt'] <= $now && $guard < 90) {
        $guard++;
        $remaining=array_values(array_diff(range(1,90),$room['calledNumbers']));
        if (!$remaining) { finish_room($room); break; }
        $number=$remaining[random_int(0,count($remaining)-1)];
        $room['calledNumbers'][]=$number;
        foreach ($room['players'] as $player) {
            if ($room['winners']['line']===null) {
                foreach ($player['cards'] as $card) if (line_complete($card,$room['calledNumbers'])) {
                    $room['winners']['line']=['name'=>$player['name'],'memberId'=>$player['memberId'],'number'=>$number,'at'=>time()];
                    award_bingo_coin($db,$player['userId'],1,'پاداش برنده یک خط دبرنا'); break;
                }
            }
        }
        foreach ($room['players'] as $player) {
            if ($room['winners']['full']===null) {
                foreach ($player['cards'] as $card) if (full_complete($card,$room['calledNumbers'])) {
                    $room['winners']['full']=['name'=>$player['name'],'memberId'=>$player['memberId'],'number'=>$number,'at'=>time()];
                    award_bingo_coin($db,$player['userId'],2,'پاداش برنده دبرنای کامل'); break;
                }
            }
        }
        $room['updatedAt']=time(); $room['nextDrawAt'] += DABERNAZ_DRAW_INTERVAL;
        if (($room['winners']['line']!==null && $room['winners']['full']!==null) || count($room['calledNumbers'])>=90) finish_room($room);
    }
}
function public_room(array $room, string $userId, array $db): array {
    $me=null; foreach ($room['players'] as $player) if ($player['userId']===$userId) {$me=$player;break;}
    $queued=in_array($userId,$room['queue'],true);
    $players=array_map(fn($p)=>['name'=>$p['name'],'memberId'=>$p['memberId']],$room['players']);
    $accountIndex=get_user_index($db,$userId);
    $account=$accountIndex>=0?$db['users'][$accountIndex]:[];
    return ['id'=>$room['id'],'status'=>$room['status'],'capacity'=>DABERNAZ_CAPACITY,
        'queueCount'=>$room['status']==='waiting'?count($room['queue']):count($room['players']),
        'players'=>$players,'calledNumbers'=>array_slice($room['calledNumbers'],-15),'allCalledNumbers'=>$room['calledNumbers'],
        'drawCount'=>count($room['calledNumbers']),'latestNumber'=>$room['calledNumbers'] ? end($room['calledNumbers']) : null,
        'winners'=>$room['winners'],'myCards'=>$me['cards'] ?? ($queued?($room['queuedCards'][$userId]??[]):[]),
        'joined'=>$queued || $me!==null,'startedAt'=>$room['startedAt'],'finishedAt'=>$room['finishedAt'],
        'myBingoCoins'=>(int)($account['bingoCoins'] ?? 0),
        'myCoinTransactions'=>array_slice($account['coinTransactions'] ?? [],0,50)];
}
function store_update(callable $callback): mixed {
    global $privateDir,$dbFile,$lockFile;
    if (!is_dir($privateDir) && !mkdir($privateDir,0700,true) && !is_dir($privateDir)) send_json(500,['error'=>'ساخت پوشه اطلاعات سرور ممکن نشد.']);
    $guard=fopen($lockFile,'c+'); if (!$guard) send_json(500,['error'=>'قفل پایگاه داده باز نشد.']);
    if (!flock($guard,LOCK_EX)) { fclose($guard); send_json(500,['error'=>'دسترسی به اطلاعات سرور ممکن نشد.']); }
    $db=['users'=>[],'rooms'=>[]];
    if (is_file($dbFile)) {
        $decoded=json_decode((string)file_get_contents($dbFile),true);
        if (is_array($decoded)) $db=$decoded;
    }
    $db['users']=is_array($db['users']??null)?$db['users']:[];
    foreach ($db['users'] as &$storedUser) { if (!isset($storedUser['bingoCoins'])) $storedUser['bingoCoins']=0; if (!isset($storedUser['coinTransactions']) || !is_array($storedUser['coinTransactions'])) $storedUser['coinTransactions']=[]; if (!isset($storedUser['stats'])) $storedUser['stats']=['gamesPlayed'=>0,'wins'=>0,'points'=>0]; }
    unset($storedUser);
    $db['rooms']=is_array($db['rooms']??null)?$db['rooms']:[];
    foreach (['room5000','room10000','room20000','room50000'] as $id) if (!isset($db['rooms'][$id])) $db['rooms'][$id]=fresh_room($id);
    try {
        $result=$callback($db);
        $json=json_encode($db,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_PRETTY_PRINT);
        $temp=$dbFile.'.'.getmypid().'.tmp';
        if (file_put_contents($temp,$json,LOCK_EX)===false || !rename($temp,$dbFile)) throw new RuntimeException('ذخیره اطلاعات سرور ناموفق بود.');
        @chmod($dbFile,0600);
        flock($guard,LOCK_UN); fclose($guard);
        return $result;
    } catch (Throwable $e) {
        flock($guard,LOCK_UN); fclose($guard); throw $e;
    }
}
function get_user_index(array $db, string $userId): int {
    foreach ($db['users'] as $i=>$user) if (($user['id']??'')===$userId) return $i;
    return -1;
}

$method=$_SERVER['REQUEST_METHOD'] ?? 'GET';
$path=$_GET['path'] ?? parse_url($_SERVER['REQUEST_URI'] ?? '/',PHP_URL_PATH);
$path='/'.trim((string)$path,'/');
if ($path==='/api/health') send_json(200,['ok'=>true,'service'=>'dabernaz','backend'=>'php','mode'=>'ready']);

if ($method==='POST' && ($path==='/api/auth/register' || $path==='/api/auth/login')) {
    $attempts=$_SESSION['auth_attempts']??['count'=>0,'until'=>time()+600];
    if (time()>$attempts['until']) $attempts=['count'=>0,'until'=>time()+600];
    $attempts['count']++; $_SESSION['auth_attempts']=$attempts;
    if ($attempts['count']>20) send_json(429,['error'=>'تعداد تلاش‌ها زیاد است. ده دقیقه بعد دوباره تلاش کن.']);
    $body=request_body(); $email=strtolower(trim((string)($body['email']??''))); $password=(string)($body['password']??'');
    if (!filter_var($email,FILTER_VALIDATE_EMAIL) || strlen($email)>190) send_json(400,['error'=>'ایمیل معتبر وارد کن.']);
    if (strlen($password)<8 || strlen($password)>128) send_json(400,['error'=>'رمز عبور باید بین ۸ تا ۱۲۸ نویسه باشد.']);
    $result=store_update(function (&$db) use ($path,$email,$password,$body) {
        if ($path==='/api/auth/register') {
            $name=trim((string)($body['name']??''));
            if (text_length($name)<2 || text_length($name)>32) return ['status'=>400,'error'=>'نام نمایشی باید بین ۲ تا ۳۲ نویسه باشد.'];
            foreach ($db['users'] as $u) if (strtolower($u['email'])===$email) return ['status'=>409,'error'=>'با این ایمیل قبلاً حساب ساخته شده است.'];
            do {$memberId=(string)random_int(100000,999999);} while (array_filter($db['users'],fn($u)=>$u['memberId']===$memberId));
            $user=['id'=>bin2hex(random_bytes(16)),'name'=>$name,'email'=>$email,'memberId'=>$memberId,
                'passwordHash'=>password_hash($password,PASSWORD_DEFAULT),'stats'=>['gamesPlayed'=>0,'wins'=>0,'points'=>0],
                'bingoCoins'=>0,'coinTransactions'=>[],'createdAt'=>gmdate('c')];
            $db['users'][]=$user;
        } else {
            $user=null; foreach ($db['users'] as $u) if (strtolower($u['email'])===$email) {$user=$u;break;}
            if (!$user || !password_verify($password,$user['passwordHash'])) return ['status'=>401,'error'=>'ایمیل یا رمز عبور اشتباه است.'];
        }
        return ['status'=>200,'user'=>public_user($user)];
    });
    if ($result['status']!==200) send_json($result['status'],['error'=>$result['error']]);
    session_regenerate_id(true); $_SESSION['userId']=$result['user']['id']; unset($_SESSION['auth_attempts']);
    send_json(200,['ok'=>true,'user'=>$result['user']]);
}

if ($method==='GET' && $path==='/api/auth/me') {
    $userId=(string)($_SESSION['userId']??'');
    if ($userId==='') send_json(200,['ok'=>true,'user'=>null]);
    $result=store_update(function (&$db) use ($userId) { $i=get_user_index($db,$userId); return $i<0?null:public_user($db['users'][$i]); });
    if (!$result) {unset($_SESSION['userId']);send_json(200,['ok'=>true,'user'=>null]);}
    send_json(200,['ok'=>true,'user'=>$result]);
}

if ($method==='POST' && $path==='/api/auth/logout') {
    $userId=(string)($_SESSION['userId']??'');
    if ($userId!=='') store_update(function (&$db) use ($userId) {
        foreach ($db['rooms'] as &$room) if ($room['status']==='waiting') {
            $room['queue']=array_values(array_filter($room['queue'],fn($id)=>$id!==$userId));
            unset($room['queuedCards'][$userId],$room['cardCounts'][$userId]);
        }
        unset($room); return true;
    });
    $_SESSION=[]; if (ini_get('session.use_cookies')) { $p=session_get_cookie_params(); setcookie(session_name(),'',time()-42000,$p['path'],$p['domain'],$p['secure'],$p['httponly']); }
    session_destroy(); send_json(200,['ok'=>true]);
}

$userId=(string)($_SESSION['userId']??'');
if ($userId==='') send_json(401,['error'=>'برای ادامه ابتدا وارد حساب کاربری شو.']);
if ($method==='PATCH' && $path==='/api/profile') {
    $body=request_body(); $name=trim((string)($body['name']??''));
    if (text_length($name)<2 || text_length($name)>32) send_json(400,['error'=>'نام نمایشی باید بین ۲ تا ۳۲ نویسه باشد.']);
    $result=store_update(function (&$db) use ($userId,$name) { $i=get_user_index($db,$userId); if($i<0)return null; $db['users'][$i]['name']=$name; return public_user($db['users'][$i]); });
    if (!$result) send_json(404,['error'=>'حساب کاربری پیدا نشد.']); send_json(200,['ok'=>true,'user'=>$result]);
}
if ($method==='POST' && $path==='/api/games/result') {
    $body=request_body(); if (!isset($body['won']) || !is_bool($body['won'])) send_json(400,['error'=>'نتیجه مسابقه معتبر نیست.']);
    $result=store_update(function (&$db) use ($userId,$body) { $i=get_user_index($db,$userId); if($i<0)return null;
        $stats=$db['users'][$i]['stats']??['gamesPlayed'=>0,'wins'=>0,'points'=>0];
        $stats['gamesPlayed']=min(100000000,(int)$stats['gamesPlayed']+1);
        if($body['won']) {$stats['wins']=min(100000000,(int)$stats['wins']+1);$stats['points']=min(1000000000,(int)$stats['points']+10);}
        $db['users'][$i]['stats']=$stats; return $stats; });
    if(!$result)send_json(404,['error'=>'حساب کاربری پیدا نشد.']); send_json(200,['ok'=>true,'stats'=>$result]);
}

if (preg_match('~^/api/rooms/(room5000|room10000|room20000|room50000)(?:/(join|leave))?$~',$path,$m)) {
    $roomId=$m[1]; $action=$m[2]??'';
    if ($method==='GET' && $action==='') {
        $room=store_update(function (&$db) use ($roomId,$userId) { $room=&$db['rooms'][$roomId]; advance_room($room,$db); return public_room($room,$userId,$db); });
        send_json(200,['ok'=>true,'room'=>$room]);
    }
    if ($method==='POST' && $action==='join') {
        $body=request_body(); $cardCount=max(1,min(4,(int)($body['cardsCount']??1)));
        $room=store_update(function (&$db) use ($roomId,$userId,$cardCount) {
            $room=&$db['rooms'][$roomId]; advance_room($room,$db);
            if($room['status']==='finished') $room=fresh_room($roomId);
            if($room['status']==='playing') return ['error'=>'این سانس در حال اجراست. بعد از پایان وارد سانس بعدی شو.','status'=>409,'room'=>public_room($room,$userId,$db)];
            if(in_array($userId,$room['queue'],true)) return ['room'=>public_room($room,$userId,$db)];
            $room['cardCounts'][$userId]=$cardCount; $room['queuedCards'][$userId]=[];
            for($i=0;$i<$cardCount;$i++)$room['queuedCards'][$userId][]=make_card();
            $room['queue'][]=$userId; $room['updatedAt']=time();
            if(count($room['queue'])>=DABERNAZ_CAPACITY) start_room($room,$db);
            return ['room'=>public_room($room,$userId,$db)];
        });
        if(isset($room['error'])) send_json($room['status'],['error'=>$room['error'],'room'=>$room['room']]);
        send_json(200,['ok'=>true,'room'=>$room['room']]);
    }
    if ($method==='POST' && $action==='leave') {
        $room=store_update(function (&$db) use ($roomId,$userId) { $room=&$db['rooms'][$roomId];
            if($room['status']==='waiting') {$room['queue']=array_values(array_filter($room['queue'],fn($id)=>$id!==$userId));unset($room['queuedCards'][$userId],$room['cardCounts'][$userId]);}
            $room['updatedAt']=time(); return public_room($room,$userId,$db); });
        send_json(200,['ok'=>true,'room'=>$room]);
    }
}
send_json(404,['error'=>'مسیر API پیدا نشد.']);
