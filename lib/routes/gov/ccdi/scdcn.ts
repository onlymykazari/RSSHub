import { load } from 'cheerio';

import type { Route } from '@/types';

import { fetchPage, parseArticle, parseNewsList, rootUrl } from './utils';

const levelMap = {
    zggb: '中管干部',
    zyyj: '中央一级党和国家机关、国企和金融单位干部',
    sggb: '省管干部',
};

const typeMap = {
    zjsc: '执纪审查',
    djcf: '党纪政务处分',
};

const sectionMap = {
    'zggb-zjsc': 0,
    'zggb-djcf': 1,
    'zyyj-zjsc': 2,
    'zyyj-djcf': 3,
    'sggb-zjsc': 4,
    'sggb-djcf': 5,
};

export const route: Route = {
    path: '/ccdi/scdcn/:level/:type',
    categories: ['government'],
    example: '/gov/ccdi/scdcn/zggb/zjsc',
    parameters: {
        level: '干部等级，可选 `zggb`（中管干部）、`zyyj`（中央一级党和国家机关、国企和金融单位干部）、`sggb`（省管干部）',
        type: '处罚类型，可选 `zjsc`（执纪审查）、`djcf`（党纪政务处分）',
    },
    radar: [
        {
            source: ['www.ccdi.gov.cn/scdcn/:level/:type/'],
            target: '/ccdi/scdcn/:level/:type',
        },
    ],
    name: '审查调查',
    maintainers: ['onlyMyKazari'],
    handler,
};

async function handler(ctx) {
    const { level, type } = ctx.req.param();
    const key = `${level}-${type}`;

    if (!(level in levelMap)) {
        throw new Error('invalid level, expected one of: zggb, zyyj, sggb');
    }
    if (!(type in typeMap)) {
        throw new Error('invalid type, expected one of: zjsc, djcf');
    }
    if (!(key in sectionMap)) {
        throw new Error('invalid level/type combination');
    }

    const currentUrl = `${rootUrl}/scdcn/${level}/${type}/`;
    let { list } = await parseNewsList(currentUrl, '.list_news_dl2 li, .list_news_dl li', ctx);

    if (!list.length) {
        const sourceHtml = await fetchPage(currentUrl);
        if (isChallengePage(sourceHtml)) {
            throw new Error('source is protected by anti-bot challenge, set CCDI_COOKIE from browser cookie to bypass');
        }

        const overviewUrl = `${rootUrl}/scdcn/`;
        const html = await fetchPage(overviewUrl);
        if (isChallengePage(html)) {
            throw new Error('overview is protected by anti-bot challenge, set CCDI_COOKIE from browser cookie to bypass');
        }
        const $ = load(html);
        const groups = $('.list_news_dl, .list_news_dl2').toArray();
        const group = groups[sectionMap[key]];

        if (group) {
            const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit'), 10) : 20;
            list = $(group)
                .find('li')
                .slice(0, limit)
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
                        link: href ? new URL(href, overviewUrl).href : undefined,
                    };
                })
                .filter((item) => item.link && item.title);
        }
    }

    if (!list.length) {
        throw new Error('failed to parse list from source page and overview page, please check if source structure changed');
    }

    const items = await Promise.all(
        list.map(async (item) => {
            try {
                return await parseArticle(item);
            } catch {
                return item;
            }
        })
    );

    return {
        title: `中央纪委国家监委网站 - 审查调查 - ${levelMap[level]} - ${typeMap[type]}`,
        link: currentUrl,
        item: items,
    };
}

function isChallengePage(html: string): boolean {
    return html.includes('captchaPage') || html.includes('seccaptcha.haplat.net') || html.includes('comImageValidate');
}
