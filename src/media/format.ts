/**
 * Подписи к результату «понять картинку» — без расчёта денег.
 *
 * Сама стоимость считается в `src/ai` по токенам провайдера (см. `costOfTokens`
 * и `usageFromResponse`). Здесь только формат для человека: округление и
 * честная оговорка, если провайдер не прислал `usage` и сумма — оценка.
 */

/** Как показать сумму: мелкие суммы не превращаем в «0,00 ₽». */
export function formatImageCost(costRub: number): string {
  if (!Number.isFinite(costRub) || costRub <= 0) return '0 ₽'
  if (costRub < 0.01) return `${costRub.toFixed(4)} ₽`
  return `${costRub.toFixed(2)} ₽`
}

/**
 * Строка о стоимости.
 *
 * `estimated` берётся из `usage.estimated` клиента. В этом случае токенов
 * картинки в оценке нет — клиент считает по символам текста, — поэтому
 * называть сумму точной нельзя: человек должен знать, что цифра неполная.
 */
export function describeImageCost(costRub: number, estimated: boolean): string {
  const amount = formatImageCost(costRub)
  return estimated
    ? `Стоимость: ${amount} (оценка — провайдер не прислал расход, токены картинки в неё не входят).`
    : `Стоимость: ${amount}.`
}
