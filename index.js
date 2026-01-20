const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const moment = require('moment');
const AdmZip = require('adm-zip');

/* ======================
    🔑 기본 설정
====================== */
const TELEGRAM_TOKEN = '8';
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

const BAD_REGEX = /(주식처분|신탁계약|기재정정|계획|예정|검토|가능성|기대|준비중|추진)/i;

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
/* ======================
    🚀 DART 메인 스캔 로직 (20% 필터 + 50% 강조 로직)
===================== */
async function scanDart() {
    if (!targetChatId) return;
    const logTime = moment().format('HH:mm:ss');

    try {
        const res = await axios.get(DART_LIST_URL, {
            params: { crtfc_key: DART_API_KEY, page_count: 15 },
            timeout: 5000
        });

        if (res.data.status !== '000') return;

        const list = res.data.list.reverse();

        for (const item of list) {
            const title = item.report_nm;
            const corp = item.corp_name;
            const rcpNo = item.rcept_no;
            const key = `${corp}_${rcpNo}`;

            if (sentSet.has(key)) continue;
            
            // 1차 필터: 제목 검사
            if (!GOOD_REGEX.test(title) || BAD_REGEX.test(title)) {
                sentSet.add(key); 
                continue;
            }

            // 2차 필터: 본문 추출
            const docDetail = await getDartDetail(rcpNo);

            let extraInfo = ""; // 추가 강조 문구용 변수

            // [핵심 필터] 단일판매/공급계약일 경우 매출액 대비 20% 필터링
            if (title.includes("단일판매") || title.includes("공급계약")) {
                const match = docDetail.match(/매출액\s*대비\s*\(?\s*%\s*\)?\s*([\d.]+)/);
                if (match) {
                    const ratio = parseFloat(match[1]);
                    
                    // 20% 미만은 전송하지 않음
                    if (ratio < 20) {
                        console.log(`[필터] ${corp}: ${ratio}% (20% 미만 스킵)`);
                        sentSet.add(key);
                        continue; 
                    }

                    // 50% 이상은 특별 강조 문구 추가
                    if (ratio >= 50) {
                        extraInfo = `\n🔥 <b>[초강력 호재] 매출액 대비 무려 ${ratio}% 수주!</b>`;
                    } else {
                        extraInfo = `\n✅ <b>매출액 대비 ${ratio}%의 우량 계약입니다.</b>`;
                    }
                }
            }
            
            // 제목이 모호한 경우 본문 정밀 검사
            if (title.includes("투자판단") || title.includes("기타시장안내")) {
                if (!DETAIL_HOT_KEYWORDS.test(docDetail)) {
                    sentSet.add(key);
                    continue;
                }
            }

            sentSet.add(key);
            if (sentSet.size > 1000) sentSet.delete(sentSet.values().next().value);

            console.log(`[${logTime}][발송] ${corp} (${title})`);

            const hotTag = extractHotKeyword(title);
            const link = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcpNo}`;
            
            await bot.sendMessage(
                targetChatId,
                `🚨 <b>[DART 호재 감지]</b>\n\n` +
                `🏢 <b>기업명:</b> ${corp}\n` +
                `📄 <b>공시제목:</b> ${title}\n` +
                `${extraInfo}\n\n` + // 여기에 강조 문구가 들어감
                `📝 <b>내용 요약:</b>\n${docDetail}\n\n` +
                `🏷️ <b>분류:</b> ${hotTag}\n` +
                `🔗 <a href="${link}">공시 원문 바로가기</a>`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
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
    🧪 기존 로직 호출형 테스트 (/test100)
====================== */
bot.onText(/\/test100/, async (msg) => {
    const chatId = msg.chat.id;
    targetChatId = chatId; // 현재 채팅방을 수신지로 설정
    
    bot.sendMessage(chatId, "📊 <b>최근 공시 100건을 대상으로 필터링 시뮬레이션을 시작합니다...</b>", { parse_mode: 'HTML' });

    try {
        // 1. 최근 100건 리스트 가져오기
        const res = await axios.get(DART_LIST_URL, {
            params: { crtfc_key: DART_API_KEY, page_count: 1000 },
            timeout: 10000
        });

        if (res.data.status !== '000') return bot.sendMessage(chatId, "❌ API 연결 실패");

        const list = res.data.list.reverse(); // 과거 -> 최신 순서로 정렬
        let totalContracts = 0;
        let passed = 0;

        for (const item of list) {
            const title = item.report_nm;
            const corp = item.corp_name;
            const rcpNo = item.rcept_no;

            // [기존 필터 로직 그대로 적용]
            if (!GOOD_REGEX.test(title) || BAD_REGEX.test(title)) continue;

            // [기존 본문 추출 함수 호출]
            const docDetail = await getDartDetail(rcpNo);
            
            let extraInfo = "";

            // 단일판매/공급계약인 경우 수치 필터링 로직 실행
            if (title.includes("단일판매") || title.includes("공급계약")) {
                totalContracts++;
                const match = docDetail.match(/매출액\s*대비\s*\(?\s*%\s*\)?\s*([\d.]+)/);
                
                if (match) {
                    const ratio = parseFloat(match[1]);
                    
                    // 20% 미만 스킵
                    if (ratio < 10) {
                        console.log(`[테스트-필터] ${corp}: ${ratio}% (기준미달)`);
                        continue; 
                    }

                    // 20% 이상인 경우 통과
                    passed++;
                    if (ratio >= 50) {
                        extraInfo = `\n🔥 <b>[초강력 호재] 매출액 대비 무려 ${ratio}% 수주!</b>`;
                    } else {
                        extraInfo = `\n✅ <b>매출액 대비 ${ratio}% 수주 확인</b>`;
                    }
                }
            }

            // [기존 메시지 전송 로직 호출 대신 여기서 직접 전송]
            const hotTag = extractHotKeyword(title);
            const link = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcpNo}`;

            await bot.sendMessage(chatId, 
                `🧪 <b>[시뮬레이션 통과]</b>\n\n` +
                `🏢 <b>기업명:</b> ${corp}\n` +
                `📄 <b>공시제목:</b> ${title}\n` +
                `${extraInfo}\n\n` +
                `📝 <b>내용 요약:</b>\n${docDetail}\n\n` +
                `🏷️ <b>분류:</b> ${hotTag}\n` +
                `🔗 <a href="${link}">원문보기</a>`,
                { parse_mode: 'HTML', disable_web_page_preview: true }
            );

            // API 부하 방지 (매칭된 경우만 약간의 대기)
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        bot.sendMessage(chatId, 
            `🏁 <b>시뮬레이션 완료!</b>\n\n` +
            `📦 발견된 공급계약: ${totalContracts}건\n` +
            `✅ 20% 이상 통과: ${passed}건\n` +
            `📉 20% 미만 차단: ${totalContracts - passed}건`, 
            { parse_mode: 'HTML' }
        );

    } catch (e) {
        bot.sendMessage(chatId, "❌ 오류 발생: " + e.message);
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

        return text.substring(0, 300) + "...";

    } catch (e) {
        return "본문 추출 실패: " + e.message;
    }
}

console.log('🚀 DART 호재 감지 엔진 작동 중...');
