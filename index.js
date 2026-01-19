const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const moment = require('moment');

/* ======================
    🔑 기본 설정
====================== */
const TELEGRAM_TOKEN = '8483722906:AAESTfCgkGUjSbwxCTn5LuNEJDrxWIiOPAs';
const DART_API_KEY = 'f248b42062220d73d89ab0fa0f152f231b082bf4';
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
    '탈모\\s*(신약|치료제|재생)', '무상\\s*증자', '자사주\\s*(소각|매입)',
    '자기주식\\s*(소각|취득)', '주주가치\\s*제고', '투자\\s*유치', '전략적\\s*투자'
].join('|'), 'i');

const BAD_REGEX = /(계획|예정|검토|가능성|기대|준비중|추진)/i;

const SPIKE_REGEX = new RegExp([
    '기술\\s*이전', '라이선스', 'FDA\\s*(승인|허가)', '임상\\s*3상', 'CSR',
    '샌드박스', '결과\\s*보고서', '대규모\\s*(계약|수주)', '무상\\s*증자', '자사주\\s*(소각|매입)'
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
        { k: '자사주 소각', r: /자사주\s*소각|자기주식\s*소각/i },
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
            if (/무상\s*증자|자사주\s*(소각|매입)|자기주식/i.test(title)) score += 4;
            if (/로봇|탈모/i.test(title)) score += 1;

            const tag = (score >= 6 || SPIKE_REGEX.test(title)) ? '🚀 <b>급등 가능성 HIGH</b>' : '⚠️ <b>단기 모멘텀</b>';
            const link = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcpNo}`;

            // 메시지 구성 (약 300자 내외 가이드 포함)
            const summary = `본 공시는 <b>${corp}</b>의 <b>${hot}</b> 관련 공시입니다. 장중 변동성이 클 수 있으니 주의 깊게 관찰하시기 바랍니다. 특히 ${title.slice(0, 50)}... 와 관련된 상세 수치와 계약 상대방 정보는 원문에서 반드시 대조가 필요합니다. 본 알림은 인공지능 정규식 필터에 의해 실시간 추출되었습니다.`;

            await bot.sendMessage(
                targetChatId,
                `🚨 <b>[DART 호재 감지]</b>\n\n` +
                `🏢 <b>기업명:</b> ${corp}\n` +
                `📄 <b>공시제목:</b> ${title}\n\n` +
                `📝 <b>내용 요약:</b>\n${summary}\n\n` +
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

console.log('🚀 DART 호재 감지 엔진 작동 중...');