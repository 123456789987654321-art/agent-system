param(
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$outputDir = Join-Path $Root 'output'
$submissionDir = Join-Path $outputDir '复赛提交材料_20260927'

$documents = @(
    @{
        Docx = Join-Path $outputDir '居家管理辅助控制系统_复赛应用方案_WPS版_20260925.docx'
        Pdf = Join-Path $outputDir '居家管理辅助控制系统_复赛应用方案_WPS版_20260925.pdf'
    },
    @{
        Docx = Join-Path $outputDir '居家管理辅助控制系统_演示视频录制教程_4分42秒_WPS版_20260925.docx'
        Pdf = Join-Path $outputDir '居家管理辅助控制系统_演示视频录制教程_4分42秒_WPS版_20260925.pdf'
    },
    @{
        Docx = Join-Path $outputDir '居家管理辅助控制系统-复赛应用方案（PDF申报内容）.docx'
        Pdf = Join-Path $outputDir '居家管理辅助控制系统-复赛应用方案（PDF申报内容）.pdf'
    }
)

foreach ($document in $documents) {
    if (-not (Test-Path -LiteralPath $document.Docx)) {
        throw "Missing source document: $($document.Docx)"
    }
}

$wps = New-Object -ComObject KWPS.Application
$wps.Visible = $false
$wps.DisplayAlerts = 0

try {
    foreach ($item in $documents) {
        $document = $wps.Documents.Open($item.Docx, $false, $false)
        try {
            foreach ($table in $document.Tables) {
                $rowCount = $table.Rows.Count
                $table.Rows.AllowBreakAcrossPages = 0
                for ($rowIndex = 1; $rowIndex -le $rowCount; $rowIndex++) {
                    $row = $table.Rows.Item($rowIndex)
                    $row.Range.ParagraphFormat.KeepTogether = -1
                    $row.Range.ParagraphFormat.KeepWithNext = if ($rowIndex -lt $rowCount) { -1 } else { 0 }
                }
            }
            $document.Save()
            $document.ExportAsFixedFormat(
                $item.Pdf,
                17,
                $false,
                0,
                0,
                0,
                0,
                0,
                $true,
                $true,
                0,
                $false,
                $true,
                $false
            )
        }
        finally {
            $document.Close($false)
        }
    }
}
finally {
    $wps.Quit()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wps) | Out-Null
}

New-Item -ItemType Directory -Force -Path $submissionDir | Out-Null
$submissionFiles = @(
    $documents[0].Docx,
    $documents[0].Pdf,
    $documents[1].Docx,
    $documents[1].Pdf
)

foreach ($file in $submissionFiles) {
    $name = [System.IO.Path]::GetFileName($file)
    $datedName = $name -replace '20260925', '20260927'
    Copy-Item -LiteralPath $file -Destination (Join-Path $submissionDir $datedName) -Force
}

Write-Output "SUBMISSION_PDFS_EXPORTED"
Write-Output $documents[0].Pdf
Write-Output $documents[1].Pdf
