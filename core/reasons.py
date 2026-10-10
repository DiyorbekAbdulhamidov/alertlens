"""Turn per-feature contributions into auditable, human-readable reasons (EN / UZ / RU).

Every reason is computed from the model's own path attributions (they sum exactly to the score);
the text only describes the client's measured values next to the peer median. No LLM is involved,
so the explanation is deterministic and reproducible for audit.
"""
import math
import numpy as np

TD = ['bank_out', 'bank_in', 'card_out', 'card_in', 'cash_out', 'cash_in', 'intl_out', 'intl_in']
LABEL = {
    'typology': {'en': 'Client typology', 'uz': 'Mijoz tipologiyasi', 'ru': 'Типология клиента'},
    'burst': {'en': 'Pre-alert burst', 'uz': 'Alert oldidan keskin faollik', 'ru': 'Всплеск перед алертом'},
    'activity': {'en': 'Activity volume and rhythm', 'uz': 'Faollik hajmi va ritmi', 'ru': 'Объём и ритм активности'},
    'timing': {'en': 'Time of day / week', 'uz': 'Kun va hafta vaqti', 'ru': 'Время суток и недели'},
    'level': {'en': 'Overall amount level and drift', 'uz': 'Umumiy summa darajasi va o\'zgarishi',
              'ru': 'Общий уровень сумм и дрейф'},
    'mix': {'en': 'Channel mix', 'uz': 'Kanallar ulushi', 'ru': 'Структура каналов'},
    'relative': {'en': 'Amounts across channels', 'uz': 'Kanallar orasidagi summalar nisbati',
                 'ru': 'Соотношение сумм между каналами'},
    'bank_out': {'en': 'Outgoing bank transfers', 'uz': 'Chiquvchi bank o\'tkazmalari', 'ru': 'Исходящие банковские переводы'},
    'bank_in': {'en': 'Incoming bank transfers', 'uz': 'Kiruvchi bank o\'tkazmalari', 'ru': 'Входящие банковские переводы'},
    'card_out': {'en': 'Card spending', 'uz': 'Karta orqali chiqimlar', 'ru': 'Расходы по карте'},
    'card_in': {'en': 'Card inflows', 'uz': 'Kartaga tushumlar', 'ru': 'Поступления на карту'},
    'cash_out': {'en': 'Cash withdrawals', 'uz': 'Naqd pul yechish', 'ru': 'Снятие наличных'},
    'cash_in': {'en': 'Cash deposits', 'uz': 'Naqd pul kiritish', 'ru': 'Внесение наличных'},
    'intl_out': {'en': 'Outgoing international transfers', 'uz': 'Chiquvchi xalqaro o\'tkazmalar',
                 'ru': 'Исходящие международные переводы'},
    'intl_in': {'en': 'Incoming international transfers', 'uz': 'Kiruvchi xalqaro o\'tkazmalar',
                'ru': 'Входящие международные переводы'},
}


def concept_of(name):
    if name == 'typology_p' or name.startswith('blk_'):
        return 'typology'
    if name.startswith('burst_') or name == 'n_burst':
        return 'burst'
    if name.startswith('eb_') and '_minus_' in name:
        return 'relative'
    for td in TD:
        if td in name:
            return td
    if name in ('night_share', 'weekend_share'):
        return 'timing'
    if name in ('amt_mean', 'amt_std', 'res_mean', 'w7_res_mean', 'w30_res_mean', 'drift_res'):
        return 'level'
    if name.endswith('_share'):
        return 'mix'
    return 'activity'


def _num(x, nd=2):
    return '—' if x is None or (isinstance(x, float) and math.isnan(x)) else f'{x:.{nd}f}'


def _med(pop, k):
    v = pop.get(k)
    return None if v is None else v[0]


def evidence(concept, f, pop):
    """Measured facts for a concept, in three languages."""
    if concept == 'typology':
        p = f['typology_p']
        s, n = int(f['blk_S_n']), int(f['blk_N_n'])
        if s > 0 and n == 0:
            src = {'en': f'{s} transaction{"s" if s != 1 else ""} in the micro-amount bands typical of the high-risk typology',
                   'uz': f'{s} ta tranzaksiya yuqori xavfli tipologiyaga xos mikro-summa oralig\'ida',
                   'ru': f'{s} операций в диапазоне микросумм, типичном для рискованной типологии'}
        elif n > 0 and s == 0:
            src = {'en': f'{n} transaction{"s" if n != 1 else ""} in the micro-amount bands typical of the low-risk typology',
                   'uz': f'{n} ta tranzaksiya past xavfli tipologiyaga xos mikro-summa oralig\'ida',
                   'ru': f'{n} операций в диапазоне микросумм, типичном для низкорисковой типологии'}
        else:
            src = {'en': 'no floor-band markers; inferred from the amount profile',
                   'uz': 'mikro-summa belgilari yo\'q; summa profilidan baholangan',
                   'ru': 'маркеров нет; оценено по профилю сумм'}
        return {'en': f'P(high-risk typology) = {p:.2f}; {src["en"]}',
                'uz': f'Yuqori xavfli tipologiya ehtimoli {p:.2f}; {src["uz"]}',
                'ru': f'P(рискованная типология) = {p:.2f}; {src["ru"]}'}
    if concept == 'burst':
        n, m = int(f['n_burst']), _med(pop, 'n_burst')
        return {'en': f'{n} transactions in the 200 s before the alert (peer median {_num(m, 0)})',
                'uz': f'Alertdan oldingi 200 soniyada {n} ta tranzaksiya (o\'rtacha mijozda {_num(m, 0)})',
                'ru': f'{n} операций за 200 с до алерта (медиана {_num(m, 0)})'}
    if concept in TD:
        n = int(f[concept + '_n'])
        lvl = f[concept + '_eb_mu']
        word = {'en': 'above' if lvl > 0 else 'below', 'uz': 'yuqori' if lvl > 0 else 'past',
                'ru': 'выше' if lvl > 0 else 'ниже'}
        mn = _med(pop, concept + '_n')
        if n == 0:
            return {'en': f'none in 180 days (peer median {_num(mn, 0)})',
                    'uz': f'180 kunda umuman yo\'q (o\'rtacha mijozda {_num(mn, 0)})',
                    'ru': f'нет за 180 дней (медиана {_num(mn, 0)})'}
        return {'en': f'{n} in 180 days (peer median {_num(mn, 0)}); amounts {abs(lvl):.2f} SD {word["en"]} peers',
                'uz': f'180 kunda {n} ta (o\'rtacha {_num(mn, 0)}); summalar boshqalardan {abs(lvl):.2f} SD {word["uz"]}',
                'ru': f'{n} за 180 дней (медиана {_num(mn, 0)}); суммы на {abs(lvl):.2f} SD {word["ru"]} нормы'}
    if concept == 'activity':
        n, d = f['n_hist'], f['active_days']
        return {'en': f'{int(n)} transactions over {_num(d, 0)} active days (peer median {_num(_med(pop, "n_hist"), 0)} / {_num(_med(pop, "active_days"), 0)})',
                'uz': f'{_num(d, 0)} faol kunda {int(n)} ta tranzaksiya (o\'rtacha {_num(_med(pop, "n_hist"), 0)} / {_num(_med(pop, "active_days"), 0)})',
                'ru': f'{int(n)} операций за {_num(d, 0)} активных дней (медиана {_num(_med(pop, "n_hist"), 0)} / {_num(_med(pop, "active_days"), 0)})'}
    if concept == 'timing':
        return {'en': f'night share {_num(f["night_share"])}, weekend share {_num(f["weekend_share"])} (peer {_num(_med(pop, "night_share"))} / {_num(_med(pop, "weekend_share"))})',
                'uz': f'tungi ulush {_num(f["night_share"])}, dam olish kunlari {_num(f["weekend_share"])} (o\'rtacha {_num(_med(pop, "night_share"))} / {_num(_med(pop, "weekend_share"))})',
                'ru': f'доля ночью {_num(f["night_share"])}, в выходные {_num(f["weekend_share"])} (медиана {_num(_med(pop, "night_share"))} / {_num(_med(pop, "weekend_share"))})'}
    if concept == 'level':
        d = f['drift_res']
        return {'en': f'amount level {_num(f["res_mean"])} SD vs peers; last-30-day drift {_num(d)} SD',
                'uz': f'summa darajasi boshqalarga nisbatan {_num(f["res_mean"])} SD; oxirgi 30 kun o\'zgarishi {_num(d)} SD',
                'ru': f'уровень сумм {_num(f["res_mean"])} SD; дрейф за 30 дней {_num(d)} SD'}
    if concept == 'mix':
        return {'en': f'incoming share {_num(f["in_share"])}, bank {_num(f["bank_share"])}, card {_num(f["card_share"])}, cash {_num(f["cash_share"])}',
                'uz': f'kirim ulushi {_num(f["in_share"])}, bank {_num(f["bank_share"])}, karta {_num(f["card_share"])}, naqd {_num(f["cash_share"])}',
                'ru': f'доля входящих {_num(f["in_share"])}, банк {_num(f["bank_share"])}, карта {_num(f["card_share"])}, наличные {_num(f["cash_share"])}'}
    if concept == 'relative':
        a = f['eb_bank_out_minus_card_out']
        return {'en': f'bank-transfer amounts vs the client\'s own card spending: {_num(a)} SD',
                'uz': f'bank o\'tkazmalari summasi mijozning o\'z karta chiqimlariga nisbatan: {_num(a)} SD',
                'ru': f'суммы переводов относительно собственных расходов по карте: {_num(a)} SD'}
    return {'en': '', 'uz': '', 'ru': ''}


def explain(f, contrib, cols, pop, expected, top=6):
    by = {}
    for name, c in zip(cols, contrib):
        if c != 0.0:
            k = concept_of(name)
            by[k] = by.get(k, 0.0) + float(c)
    items = sorted(by.items(), key=lambda kv: -abs(kv[1]))
    concepts = []
    for k, c in items[:top]:
        concepts.append({'key': k, 'label': LABEL[k], 'logodds': round(c, 4), 'odds_x': round(math.exp(c), 3),
                         'direction': 'up' if c > 0 else 'down', 'evidence': evidence(k, f, pop)})
    feats = sorted(((n, float(c)) for n, c in zip(cols, contrib)), key=lambda kv: -abs(kv[1]))[:12]
    detail = [{'feature': n, 'value': (None if f[n] is None or (isinstance(f[n], float) and math.isnan(f[n])) else round(float(f[n]), 4)),
               'peer_median': _med(pop, n), 'logodds': round(c, 4)} for n, c in feats]
    return {'base_logodds': round(expected, 4), 'concepts': concepts, 'features': detail}


ACTION = {
    'P1': {'en': 'Priority review today', 'uz': 'Bugunoq ustuvor ko\'rib chiqish', 'ru': 'Приоритетная проверка сегодня'},
    'P2': {'en': 'Standard review', 'uz': 'Odatiy tartibda ko\'rib chiqish', 'ru': 'Стандартная проверка'},
    'P3': {'en': 'Low priority: review after P1/P2', 'uz': 'Past ustuvorlik: P1/P2 dan keyin',
           'ru': 'Низкий приоритет: после P1/P2'},
}


def memo(alert_id, r, lang='en', model_version='alertlens-1.0'):
    """Deterministic case memo draft. The officer edits and signs it; the decision stays human."""
    band = r.get('band', 'P2')
    up = [c for c in r['reasons']['concepts'] if c['direction'] == 'up'][:3]
    dn = [c for c in r['reasons']['concepts'] if c['direction'] == 'down'][:2]
    p = r['probability']
    rate = r.get('band_escalation_rate')
    T = {
        'en': ('CASE MEMO (draft)', 'Alert', 'Risk score', 'Queue band', 'historical escalation rate in this band',
               'Suggested handling', 'Factors raising risk', 'Factors lowering risk', 'none',
               'Decision: to be taken by the reviewing officer. Model', 'odds'),
        'uz': ('ISH BO\'YICHA XULOSA (qoralama)', 'Alert', 'Xavf bahosi', 'Navbat guruhi',
               'bu guruhda tarixiy eskalatsiya ulushi', 'Tavsiya etilgan tartib', 'Xavfni oshiruvchi omillar',
               'Xavfni kamaytiruvchi omillar', 'yo\'q', 'Qaror: ko\'rib chiquvchi xodim tomonidan qabul qilinadi. Model',
               'imkoniyat'),
        'ru': ('СЛУЖЕБНАЯ ЗАПИСКА (черновик)', 'Алерт', 'Оценка риска', 'Группа очереди',
               'историческая доля эскалаций в группе', 'Рекомендуемый порядок', 'Факторы, повышающие риск',
               'Факторы, снижающие риск', 'нет', 'Решение принимает проверяющий сотрудник. Модель', 'шансы'),
    }[lang]
    lines = [T[0], f'{T[1]}: {alert_id}', f'{T[2]}: {p:.3f}',
             f'{T[3]}: {band}' + (f' ({T[4]}: {rate:.0%})' if rate is not None else ''),
             f'{T[5]}: {ACTION.get(band, ACTION["P2"])[lang]}', '', f'{T[6]}:']
    lines += [f'  • {c["label"][lang]} — {c["evidence"][lang]} ({T[10]} ×{c["odds_x"]:.2f})' for c in up] or [f'  • {T[8]}']
    lines += ['', f'{T[7]}:']
    lines += [f'  • {c["label"][lang]} — {c["evidence"][lang]} ({T[10]} ×{c["odds_x"]:.2f})' for c in dn] or [f'  • {T[8]}']
    lines += ['', f'{T[9]}: {model_version}.']
    return '\n'.join(lines)
