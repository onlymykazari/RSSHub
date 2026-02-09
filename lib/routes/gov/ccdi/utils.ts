import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { load } from 'cheerio';
import { Cookie, CookieJar } from 'tough-cookie';
import { Agent, fetch as undiciFetch } from 'undici';

import { config } from '@/config';
import cache from '@/utils/cache';
import { parseDate } from '@/utils/parse-date';
import timezone from '@/utils/timezone';

const cookieJar = new CookieJar();

const owner = '中央纪委国家监委网站';
const rootUrl = 'https://www.ccdi.gov.cn';
const regex = /(?<key>[A-Za-z0-9_]+)=(?<value>(?:.*?(?=; max-age)|[\dA-Fa-f]+))/gm;
const ipv4Dispatcher = new Agent({
    connect: {
        family: 4,
    },
});
const requestHeaders = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'max-age=0',
    Connection: 'keep-alive',
    Referer: `${rootUrl}/`,
    'sec-ch-ua': '"Not;A=Brand";v="99", "Google Chrome";v="139", "Chromium";v="139"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': config.ua,
};
const execFileAsync = promisify(execFile);
const customCookie = process.env.CCDI_COOKIE
    ?.replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

const parseCookie = async (body) => {
    let m;
    const cookies = [];
    while ((m = regex.exec(body)) !== null) {
        // This is necessary to avoid infinite loops with zero-width matches
        if (m.index === regex.lastIndex) {
            regex.lastIndex++;
        }
        const { key, value } = m.groups;
        cookies.push(new Cookie({ key, value }));
    }
    await Promise.all(cookies.map((c) => cookieJar.setCookie(c, rootUrl)));
};

const requestWithFallback = async (url) => {
    try {
        return await requestWithUndici(url);
    } catch (error) {
        try {
            return await requestWithCurl(url);
        } catch {
            // ignore and try protocol fallback
        }
        if (!url.startsWith('https://')) {
            throw error;
        }
        const fallbackUrl = url.replace(/^https:\/\//, 'http://');
        try {
            return await requestWithUndici(fallbackUrl);
        } catch {
            return requestWithCurl(fallbackUrl);
        }
    }
};

const fetchPage = async (url) => {
    for (let i = 0; i < 5; i++) {
        const response = await requestWithFallback(url);
        const data = response.data;
        await parseCookie(data);

        // Some anti-bot pages set cookies in inline script and require a follow-up request.
        const isChallengePage =
            data.includes('captchaPage') || data.includes('seccaptcha.haplat.net') || (data.includes('window.open(') && data.includes('document.cookie'));
        if (!isChallengePage) {
            return data;
        }
    }

    const response = await requestWithFallback(url);
    const data = response.data;
    await parseCookie(data);
    return data;
};

const parseNewsList = async (url, selector, ctx) => {
    const data = await fetchPage(url);

    const $ = load(data);
    const list = $(selector)
        .slice(0, ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 20)
        .toArray()
        .map((item) => {
            const node = $(item);
            const anchor = node
                .find('a')
                .toArray()
                .map((el) => $(el))
                .find((el) => el.text().trim().length > 0) ?? node.find('a').first();
            const href = anchor.attr('href');
            return {
                title: anchor.text().trim(),
                link: href ? new URL(href, url).href : undefined,
                pubDate: parseDate(node.find('.more, span').first().text().trim(), 'YYYY-MM-DD'),
            };
        })
        .filter((item) => item.link && item.title);
    const title = $('.other_Location')
        .text()
        .replace(/(.+)首页/, owner);
    return { list, title };
};

const changeTrCookie = async () => {
    const cookies = await cookieJar.getCookies(rootUrl);
    const c = cookies.find((c) => c.key === 'HOY_TR');
    if (c) {
        const value = c.value;
        const tr_array = value.split(',');
        const csr = tr_array[0];
        const cnv = [...tr_array[1]];
        const otr = [...tr_array[2]];
        otr[0] = csr.charAt(Number.parseInt(cnv[0], 16));
        const nc = new Cookie({ key: 'HOY_TR', value: csr + ',' + cnv.join('') + ',' + otr.join('') + ',0' });
        await cookieJar.setCookie(nc, rootUrl);
    }
};

const requestWithUndici = async (url: string) => {
    const cookies = cookieJar.getCookiesSync(url);
    const headers: Record<string, string> = {
        ...requestHeaders,
    };
    const cookieParts = [];
    if (customCookie) {
        cookieParts.push(customCookie);
    }
    if (cookies.length > 0) {
        cookieParts.push(cookies.map((c) => c.cookieString()).join('; '));
    }
    if (cookieParts.length > 0) {
        headers.cookie = cookieParts.join('; ');
    }

    const response = await undiciFetch(url, {
        headers,
        dispatcher: ipv4Dispatcher,
        redirect: 'follow',
    });
    const data = await response.text();

    const setCookie = response.headers.getSetCookie?.() ?? [];
    await Promise.all(setCookie.map((cookie) => cookieJar.setCookie(cookie, url)));

    return {
        data,
        body: data,
    };
};

const requestWithCurl = async (url: string) => {
    const cookies = cookieJar.getCookiesSync(url);
    const cookieParts = [];
    if (customCookie) {
        cookieParts.push(customCookie);
    }
    if (cookies.length > 0) {
        cookieParts.push(cookies.map((c) => c.cookieString()).join('; '));
    }

    const args = ['-sSL', '--http1.1', '--compressed', '--connect-timeout', '10', '--max-time', '25', url];
    for (const [key, value] of Object.entries(requestHeaders)) {
        args.push('-H', `${key}: ${value}`);
    }
    if (cookieParts.length > 0) {
        args.push('--cookie', cookieParts.join('; '));
    }

    const { stdout } = await execFileAsync('curl', args, {
        maxBuffer: 5 * 1024 * 1024,
    });

    return {
        data: stdout,
        body: stdout,
    };
};

const parseArticle = async (item) => {
    await changeTrCookie();
    return cache.tryGet(item.link, async () => {
        const response = await requestWithFallback(item.link);
        const data = response.data;
        await parseCookie(data);

        const $ = load(data);
        const title = $('.daty, .source-box').text().trim();
        item.author = title.match(/来源：(.*)发布时间/s)?.[1].trim() ?? owner;
        item.pubDate = timezone(parseDate(title.match(/发布时间：(.*)分享/s)?.[1].trim() ?? item.pubDate), +8);

        // Change the img src from relative to absolute for a better compatibility
        $('.content, .bom-box')
            .find('img')
            .each((_, el) => {
                $(el).attr('src', new URL($(el).attr('src'), item.link).href);
                // oldsrc is causing freshrss imageproxy not to work correctly
                $(el).removeAttr('oldsrc').removeAttr('alt');
            });
        item.description = $('.content, .bom-box').html();
        return item;
    });
};

export { fetchPage, parseArticle, parseNewsList, rootUrl };
