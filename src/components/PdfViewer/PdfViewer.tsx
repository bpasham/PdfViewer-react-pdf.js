import React, {Component, Fragment} from 'react'
import PropTypes from 'prop-types'
import pdfjs from 'pdfjs-dist'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.entry'
import { AnnotationLayerBuilder } from 'pdfjs-dist/lib/web/annotation_layer_builder'
import { PDFLinkService } from 'pdfjs-dist/lib/web/pdf_link_service'
import NullL10n from 'pdfjs-dist/lib/web/ui_utils.js'
import screenfull from 'screenfull'
import isMobile from 'ismobilejs'
import throttle from 'lodash/throttle'
import {
  PdfViewerPropsTypes,
  PdfViewerStateTypes,
  pageType
} from './types'
import Upload from '../Upload/Upload'
import './pdfViewer.sass'

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker

const MAX_RELOAD_COUNT_ON_ERROR = 2

class PdfViewer extends Component<PdfViewerPropsTypes, PdfViewerStateTypes> {
  static propTypes = {
    src: PropTypes.string,
    sandbox: PropTypes.bool
  }

  state: PdfViewerStateTypes = {
    pdf: null,
    testFileContent: null,
    pagesCount: 0,
    currentPageNumber: 1,
    onCatchErrorReloadedCount: 0,
    switchPageBlocked: false,
    scale: 1,
    isPdfLoaded: false,
    isShowError: false,
    pdfLoadingError: false
  }

  isPageRendering = false

  private wrap = React.createRef<HTMLDivElement>()
  private document = React.createRef<HTMLDivElement>()
  private canvas = React.createRef<HTMLCanvasElement>()
  private textAndAnnotationLayer = React.createRef<HTMLDivElement>()
  throttledChangeDocumentSize

  componentDidMount () {
    this.fetchPdf(this.props.src)
        .then(() => this.pageRendering())
        .catch(() => this.setState({pdfLoadingError: true}))

    this.throttledChangeDocumentSize = throttle(this.pageRendering, 100)
    window.addEventListener('resize', this.throttledChangeDocumentSize)
  }

  componentWillUnmount () {
    window.removeEventListener('resize', this.throttledChangeDocumentSize)
  }

  componentDidUpdate (nextProps) {
    if (nextProps.src !== this.props.src) {
      this.setState({
        isShowError: false,
        pdfLoadingError: false,
        pdf: null,
        testFileContent: null,
        currentPageNumber: 1,
        pagesCount: 0
      })
      // отрисовываем новый pdf
      this.fetchPdf(nextProps.link)
        .then(() => this.pageRendering())
        .catch(() => this.setState({pdfLoadingError: true}))
    }
  }

  componentDidCatch () {
    const { onCatchErrorReloadedCount } = this.state
    // если по каким-то причинам происходит эксепшн, то перезагружаем документ
    // и он будет загружен на текущей странице, если попытки закончились, показываем ошибку

    if (onCatchErrorReloadedCount < MAX_RELOAD_COUNT_ON_ERROR) {
      this.setState({ onCatchErrorReloadedCount: onCatchErrorReloadedCount + 1 })
    } else {
      this.setState({ isShowError: true })
    }
  }

  private fetchPdf = async (src: string) => {
    const loadingTask = pdfjs.getDocument(src)
    const pdf = await loadingTask.promise
    this.setState({pdf, isPdfLoaded: true, pagesCount: pdf.numPages})
  }

  private pageRendering = async () => {
    if (this.isPageRendering) return
    this.setState({switchPageBlocked: true})
    this.isPageRendering = true

    const {state: { currentPageNumber, pdf }} = this

    if (!pdf) return
    const page: pageType = await pdf.getPage(currentPageNumber)

    // подготовка canvas по размерам pdf при выбранном scale
    const scale = this.getScaleForCurrentWidth(page)
    const viewport = await page.getViewport({scale})
    this.canvas.current.height = viewport.height
    this.canvas.current.width = viewport.width

    // рендерим страницу pdf в контекст canvas
    const context = this.canvas.current.getContext('2d')
    const renderContext = {
      canvasContext: context,
      viewport: viewport
    }
    const renderTask = page.render(renderContext)
    await renderTask.promise

    // получаем текстовое содержимое pdf
    const textContent = await page.getTextContent()
    this.textAndAnnotationLayer.current.innerHTML = ''

    // рендерим текст из pdf
    pdfjs.renderTextLayer({
      textContent: textContent,
      container: this.textAndAnnotationLayer.current,
      viewport: viewport,
      textDivs: []
    })

    // рендерим аннотации
    // необходимо рендерить текст и аннотации в один слой иначе слои перекрывают друг друга
    const linkService = await new PDFLinkService({
      // для того что бы ссылки открывались в новой вкладке, по умолчанию NONE
      externalLinkTarget: pdfjs.LinkTarget.BLANK
    })

    const annotation = new AnnotationLayerBuilder({
      pageDiv: this.textAndAnnotationLayer.current,
      linkService: linkService,
      pdfPage: page,
      l10n: NullL10n
    })
    annotation.render(viewport)

    this.setState({switchPageBlocked: false})
    this.isPageRendering = false
  }

  private getScaleForCurrentWidth (page) {
    // это необходимо так как размеры canvas, textLayer и annotationLayer зависят от viewport
    // поэтому что бы canvas и другие слои были правильных размеров нужно вычислить scale
    // вычисляю по пропорции опираясь на ширину или высоту
    const viewport = page.getViewport({scale: this.state.scale})
    let newScale = this.state.scale

    if (this.wrap.current.clientWidth === viewport.width) return newScale

    // @ts-ignore
    // screenfull library not support types
    if (screenfull.isFullscreen && viewport.width / viewport.height < 1.5) {
      newScale = this.wrap.current.clientHeight / viewport.height * this.state.scale
    } else {
      newScale = this.wrap.current.clientWidth / viewport.width * this.state.scale
    }

    this.setState({scale: newScale})
    return newScale
  }

  private switchPageHandler = (next = false) => {
    const { currentPageNumber, pagesCount, switchPageBlocked } = this.state

    if (switchPageBlocked) return

    let newPageNumber = next ? currentPageNumber + 1 : currentPageNumber - 1
    if (newPageNumber < 1) newPageNumber = 1
    if (newPageNumber > pagesCount) newPageNumber = pagesCount

    this.setState(
      { currentPageNumber: newPageNumber, switchPageBlocked: currentPageNumber !== newPageNumber },
      () => this.pageRendering()
    )
  }

  private toggleFullScreenHandler = () => {
    const el = this.wrap.current

    if (!el) return

    // @ts-ignore
    // screenfull library not support types
    screenfull.toggle(el)
  }

  afterUpload = ({ fileContent }) => {
    this.setState({ testFileContent: fileContent, pdfLoadingError: false })
    this.fetchPdf(fileContent)
      .then(() => this.pageRendering())
  }

  render(): React.ReactElement {
    const { sandbox, src } = this.props
    const {
      isShowError,
      isPdfLoaded,
      pdfLoadingError,
      testFileContent,
      switchPageBlocked,
      pagesCount,
      currentPageNumber
    } = this.state

    const file = sandbox ? testFileContent : src

    if (isShowError) {
      return (
        <div className='root'>
          Произошла ошибка при просмотре документа
        </div>
      )
    }

    if (pdfLoadingError && !sandbox) {
      return (
        <div className='root'>
          Не удалось загрузить pdf файл
        </div>
      )
    }

    return (
      <div className='root'>
        {
          sandbox && !testFileContent &&
          <div className='sandbox'>
            <p><strong>Sandbox</strong></p>
            <Upload
              afterUploadAction={this.afterUpload}
              maxSizeInKB={1000000000}
              accept={['application/pdf']}
              label='Выберите PDF документ'
            />
          </div>
        }
        {
          isPdfLoaded
          ? <div className='wrap' ref={this.wrap}>
              <div className='document' ref={this.document}>
                <canvas className='canvas' ref={this.canvas} />
                <div className='textAndAnnotationLayer' ref={this.textAndAnnotationLayer} />

                <div className='controls'>
                  <div className='leftControls'>
                    {
                      pagesCount > 1 && (
                        <Fragment>
                          <div className='previous' onClick={() => !switchPageBlocked ? this.switchPageHandler() : null} />

                          <div className='next' onClick={() => !switchPageBlocked ? this.switchPageHandler(true) : null} />
                        </Fragment>
                      )
                    }
                    <div className='pages'>Страница {currentPageNumber} из {pagesCount}</div>
                  </div>

                  <div className='rightControls'>
                    <a className='download' download href={file} />

                    {
                      // @ts-ignore
                      screenfull.isEnabled && !isMobile('any').any && <div className='fullscreen' onClick={this.toggleFullScreenHandler} />
                    }
                  </div>
                </div>
              </div>
            </div>
            : !sandbox && <div>Идет загрузка документа...</div>
        }
      </div>
    )
  }
}

export default PdfViewer
