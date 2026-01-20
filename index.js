const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const moment = require('moment');
const AdmZip = require('adm-zip');

/* ======================
    🔑 기본 설정
====================== */
const TELEGRAM_TOKEN = '';
const DART_API_KEY = '';
const DART_LIST_URL = 'https://opendart.fss.or.kr/api/list.json';
const DART_DOC_URL = 'https://opendart.fss.or.kr/api/document.xml'; // 본문 추출용

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

let isMonitoring = false;
let monitorTimer = null;
let targetChatId = null;
const sentSet = new Set();

/* ======================
    🔥 기존 호재 정규식 (유지)
====================== */
const GOOD_REGEX = new RegExp([
    '임상\\s*(시험)?\\s*(결과|성공)', '임상\\s*[23]상\\s*(성공|완료)', '임상\\s*[23]상\\s*결과',
    'FDA\\s*(승인|허가)', 'IND\\s*(승인|허가)', 'NDA\\s*(제출|접수)', '기술\\s*이전',
    '라이선스\\s*아웃', 'L\\/O', '규제\\s*샌드박스', '샌드박스\\s*(선정|승인|통과)',
    'CSR\\s*(제출|수령|확인|결과)', '결과\\s*보고서', '최종\\s*결과\\s*보고',
    '로봇\\s*(신제품|출시|공개)', '산업용\\s*로봇', 'AI\\s*로봇', '휴머노이드\\s*로봇',
    '자율주행\\s*로봇', '(대규모|글로벌)?\\s*(공급|수주|계약)\\s*(체결|확보|완료)',
    '탈모\\s*(신약|치료제|재생)', '무상\\s*증자'
].join('|'), 'i');

const BAD_REGEX = /(계획|예정|검토|가능성|기대|준비중|추진)/i;

const SPIKE_REGEX = new RegExp([
    '기술\\s*이전', '라이선스', 'FDA\\s*(승인|허가)', '임상\\s*3상', 'CSR',
    '샌드박스', '결과\\s*보고서', '대규모\\s*(계약|수주)', '무상\\s*증자'
].join('|'), 'i');

/* ======================
    🏷️ 호재 키워드 추출 (기존 유지)
====================== */
function extractHotKeyword(title) {
    const map = [
        { k: '임상 3상 결과', r: /임상\s*3상.*(결과|성공)/i },
        { k: '임상 2상 결과', r: /임상\s*2상.*(결과|성공)/i },
        { k: 'CSR', r: /CSR/i },
        { k: '샌드박스', r: /샌드박스/i },
        { k: 'FDA 승인', r: /FDA\s*(승인|허가)/i },
        { k: '기술이전', r: /기술\s*이전/i },
        { k: '라이선스', r: /(라이선스|L\/O)/i },
        { k: '무상증자', r: /무상\s*증자/i },        
        { k: '대규모 계약', r: /(대규모|글로벌).*(계약|수주|공급)/i }
    ];
    for (const m of map) { if (m.r.test(title)) return m.k; }
    return '기타 호재';
}

/* ======================
    ⏰ 장 시간 체크 (09:00 ~ 15:40)
====================== */
function isMarketOpen() {
    const now = new Date();
    const day = now.getDay();
    const currentTime = now.getHours() * 100 + now.getMinutes();
    if (day === 0 || day === 6) return false;
    return currentTime >= 900 && currentTime <= 2140;
}

/* ======================
    🔍 본문 300자 추출 함수
====================== */
async function getDocSummary(rcpNo) {
    try {
        // DART 본문 API는 zip으로 응답하므로 처리가 까다롭지만, 
        // 제목과 리스트 데이터를 조합하여 300자 내외의 리포트 형태를 생성합니다.
        return `해당 공시(${rcpNo})는 기업의 주요 경영 사항을 담고 있습니다. 상세 내용은 원문 링크를 통해 확인해 주세요.`;
    } catch (e) { return "본문 요약을 불러올 수 없습니다."; }
}

/* ======================
    🚀 DART 메인 스캔 로직
===================== */
async function scanDart() {
    if (!targetChatId) return;
    const logTime = moment().format('HH:mm:ss');

    if (!isMarketOpen()) {
        console.log(`[${logTime}][시스템] 장 운영 시간 외 대기 중...`);
        return;
    }

    try {
        const res = await axios.get(DART_LIST_URL, {
            params: { crtfc_key: DART_API_KEY, page_count: 20 },
            timeout: 5000
        });

        if (res.data.status !== '000') return;

        const list = res.data.list.reverse();

        for (const item of list) {
            const title = item.report_nm;
            const corp = item.corp_name;
            const rcpNo = item.rcept_no;
            const hot = extractHotKeyword(title);

            if (BAD_REGEX.test(title)) continue;
            if (!GOOD_REGEX.test(title)) continue;

            const key = `${corp}_${title}_${rcpNo}`;
            if (sentSet.has(key)) continue;
            sentSet.add(key);
            if (sentSet.size > 1000) sentSet.delete(sentSet.values().next().value);

            // [시간][종목명][내용] 로그 출력
            console.log(`[${logTime}][${corp}][${title}]`);

            /* ===== 점수 시스템 (기존 유지) ===== */
            let score = 0;
            if (/임상\s*[23]상|CSR|결과\s*보고서/i.test(title)) score += 3;
            if (/FDA\s*(승인|허가)|기술\s*이전|라이선스/i.test(title)) score += 3;
            if (/(대규모|글로벌).*(계약|수주|공급)/i.test(title)) score += 3;
            else if (/(계약|수주|공급)/i.test(title)) score += 2;
            if (/무상\s*증자/i.test(title)) score += 4;
            if (/로봇|탈모/i.test(title)) score += 1;

            const tag = (score >= 6 || SPIKE_REGEX.test(title)) ? '🚀 <b>급등 가능성 HIGH</b>' : '⚠️ <b>단기 모멘텀</b>';
            const link = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcpNo}`;

            const docDetail = await getDartDetail(rcpNo, item.dcm_no);

            // 메시지 구성 (약 300자 내외 가이드 포함)
            

            await bot.sendMessage(
                targetChatId,
                `🚨 <b>[DART 호재 감지]</b>\n\n` +
                `🏢 <b>기업명:</b> ${corp}\n` +
                `📄 <b>공시제목:</b> ${title}\n\n` +
                `📝 <b>내용 요약:</b>\n${docDetail}\n\n` +
                `🏷️ <b>키워드:</b> ${hot}\n` +
                `🔥 <b>점수:</b> <b>${score}</b>\n` +
                `${tag}\n\n` +
                `🔗 <a href="${link}">공시 원문 바로가기</a>`,
                { parse_mode: 'HTML', disable_web_page_preview: false }
            );
        }
    } catch (e) { console.error(`[${logTime}][에러] ${e.message}`); }
}

/* ======================
    🤖 명령 처리
====================== */
bot.onText(/\/on/, (msg) => {
    targetChatId = msg.chat.id;
    if (!isMonitoring) {
        isMonitoring = true;
        bot.sendMessage(targetChatId, "🚀 <b>DART 실시간 모니터링 가동</b>\n(평일 09:00~21:40 / 3초 간격)", { parse_mode: 'HTML' });
        scanDart();
        monitorTimer = setInterval(scanDart, 3000); 
    }
});

bot.onText(/\/off/, (msg) => {
    isMonitoring = false;
    clearInterval(monitorTimer);
    bot.sendMessage(msg.chat.id, "🛑 <b>모니터링 중지</b>");
});


/* ======================
    🧪 즉시 테스트 명령어 (/test)
====================== */
bot.onText(/\/test/, async (msg) => {
    const chatId = msg.chat.id;
    targetChatId = chatId; // 테스트를 위해 현재 채팅방을 타겟으로 설정
    
    bot.sendMessage(chatId, "🔍 <b>DART 실시간 서버에서 최근 공시 3개를 가져와 테스트를 시작합니다...</b>", { parse_mode: 'HTML' });

    try {
        // 최근 3개의 공시 리스트 호출
        const res = await axios.get(DART_LIST_URL, {
            params: { crtfc_key: DART_API_KEY, page_count: 3 },
            timeout: 5000
        });

        if (res.data.status !== '000') {
            return bot.sendMessage(chatId, `❌ DART API 연결 실패: ${res.data.message}`);
        }

        const list = res.data.list;

        for (const item of list) {
            const title = item.report_nm;
            const corp = item.corp_name;
            const rcpNo = item.rcept_no;
            
            // 1. 본문 추출 함수 호출
            const docDetail = await getDartDetail(rcpNo);
            
            // 2. 호재 여부와 상관없이 무조건 전송 (테스트 목적)
            const hot = extractHotKeyword(title);
            const link = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcpNo}`;

            await bot.sendMessage(
                chatId,
                `🧪 <b>[테스트 전송]</b>\n\n` +
                `🏢 <b>기업명:</b> ${corp}\n` +
                `📄 <b>공시제목:</b> ${title}\n\n` +
                `📝 <b>내용 요약:</b>\n${docDetail}\n\n` +
                `🏷️ <b>예상 키워드:</b> ${hot}\n` +
                `🔗 <a href="${link}">공시 원문 바로가기</a>`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            );
            
            // 연속 전송 시 메시지 순서 꼬임 방지 (1초 대기)
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        bot.sendMessage(chatId, "✅ <b>3건의 테스트 전송이 완료되었습니다.</b>\n본문에 CSS 찌꺼기가 섞이지 않았는지 확인해 보세요.");

    } catch (e) {
        bot.sendMessage(chatId, `❌ 테스트 중 오류 발생: ${e.message}`);
    }
});




async function getDartDetail(rcpNo) {
    const apiUrl = `https://opendart.fss.or.kr/api/document.xml?crtfc_key=${DART_API_KEY}&rcept_no=${rcpNo}`;
    
    try {
        const res = await axios.get(apiUrl, { responseType: 'arraybuffer' });
        const zip = new AdmZip(res.data);
        const zipEntries = zip.getEntries();
        
        if (zipEntries.length === 0) return "본문 파일이 없습니다.";
        let content = zipEntries[0].getData().toString('utf8');

        // 1. CSS 및 Style 태그 완전 박멸 (정규식 강화)
        content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
        content = content.replace(/\.[a-zA-Z0-9_.-]+\s*\{[\s\S]*?\}/g, "");

        // 2. HTML 태그 제거
        let text = content.replace(/<[^>]*>?/g, " ");

        // 3. 텍스트 기본 정제
        text = text
            .replace(/&nbsp;/g, " ")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .trim();

        // 4. 가독성을 위한 줄바꿈 로직 (핵심)
        text = text
            .replace(/\s+/g, " ")               // 연속 공백 제거
            .replace(/([0-9]\.) /g, "\n\n$1 ")   // "1. " "2. " 앞에 두 줄 줄바꿈
            .replace(/([-·가-힣]\s*[:]) /g, "\n$1 ") // "항목 :" 뒤에 줄바꿈
            .replace(/([가-힣]{2,4}[일|일자|액|율|일|점]) /g, "$1\n") // 주요 단어 뒤 줄바꿈
            .replace(/(다\.) /g, "다.\n")        // 문장 끝 줄바꿈
            .replace(/([\)\]]) /g, "$1\n");     // 괄호 닫기 뒤 줄바꿈

        // 5. CSS 찌꺼기가 시작점에 남아있을 경우 제거
        const startIdx = text.search(/[제목|성명|1\.|【]/);
        if (startIdx !== -1) {
            text = text.substring(startIdx);
        }

        // 6. 결과 정리
        let finalLines = text.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0); // 빈 줄 제거

        text = finalLines.join('\n');

        return text.substring(0, 500) + "...";

    } catch (e) {
        return "본문 추출 실패: " + e.message;
    }
}

console.log('🚀 DART 호재 감지 엔진 작동 중...');
